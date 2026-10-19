"""Read-only, identity-bound accounting for a Launch Services app and its WebKit XPCs.

Private Darwin query ABIs are optional and fail closed. No process is signalled.
A shell-shared coalition or responsible PID is NOT application attribution.
See docs/m2-accounting-closeout.md for provider sources and limitations.
"""

import argparse
import ctypes
import json
import os
import sys
import time
from pathlib import Path

import psutil
from kernel_counters import sample_counters
from registered_app import verify
from summarize_runtime_observation import summarize

WEBKIT_ROLES = {
    "com.apple.WebKit.WebContent": "web-content",
    "com.apple.WebKit.Networking": "network",
    "com.apple.WebKit.GPU": "gpu",
}
WEBKIT_ROOT = Path("/System/Library/Frameworks/WebKit.framework")


class AttributionError(ValueError):
    """A missing attribution boundary is not a zero-memory measurement."""


class NativeQueries:
    def __init__(self):
        if sys.platform != "darwin":
            raise AttributionError("macos-provider-unavailable")
        try:
            self.system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
            self.libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            self.responsible = self.system.responsibility_get_pid_responsible_for_pid
            self.responsible.argtypes = [ctypes.c_int]
            self.responsible.restype = ctypes.c_int
            self.pidinfo = self.libproc.proc_pidinfo
            self.pidinfo.argtypes = [
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_uint64,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            self.pidinfo.restype = ctypes.c_int
        except (OSError, AttributeError) as error:
            raise AttributionError("native-attribution-provider-unavailable") from error

    def coalition(self, pid):
        # proc_pidcoalitioninfo: two coalition IDs followed by three reserved u64s.
        value = (ctypes.c_uint64 * 5)()
        size = ctypes.sizeof(value)
        if size != 40 or self.pidinfo(pid, 20, 0, ctypes.byref(value), size) != size:
            raise AttributionError("coalition-query-unavailable")
        if not value[0] or not value[1]:
            raise AttributionError("invalid-coalition-identity")
        return int(value[0]), int(value[1])


def assert_boundary(root_pid, responsible_pid, root_coalition, observer_coalition):
    if root_pid != responsible_pid:
        raise AttributionError("app-is-not-self-responsible")
    if any(a == b for a, b in zip(root_coalition, observer_coalition, strict=True)):
        raise AttributionError("app-shares-controller-coalition")


def webkit_role(executable, framework_root=WEBKIT_ROOT):
    path = Path(executable).resolve(strict=True)
    root = Path(framework_root).resolve(strict=True)
    if not path.is_relative_to(root):
        return None
    role = WEBKIT_ROLES.get(path.name)
    if role is None or path.parent.name != "MacOS" or path.parent.parent.name != "Contents":
        return None
    if path.parent.parent.parent.name != path.name + ".xpc":
        return None
    return role


def service_matches(root_pid, root_coalition, responsible, coalition, uid, expected_uid, role):
    return (
        role in WEBKIT_ROLES.values()
        and uid == expected_uid
        and responsible == root_pid
        and coalition == root_coalition
    )


def same_process(pid, created):
    try:
        current = psutil.Process(pid)
        return (
            current.create_time() == created
            and current.is_running()
            and current.status() != psutil.STATUS_ZOMBIE
        )
    except psutil.NoSuchProcess:
        return False


def sample_group(root_process, created, executable, native):
    """Enumerate only same-user WebKit candidates; retain only attributed resources."""
    root_pid = root_process.pid
    # Fresh objects avoid relying on a cached create_time across PID reuse.
    actual, current_creation = verify(root_pid, executable)
    if current_creation != created:
        raise AttributionError("registered-pid-reused")
    root_coalition = native.coalition(root_pid)
    assert_boundary(
        root_pid, native.responsible(root_pid), root_coalition, native.coalition(os.getpid())
    )
    uid = actual.uids().real
    descendants = {p.pid: p for p in [actual, *actual.children(recursive=True)]}
    if len(descendants) > 256:
        raise AttributionError("descendant-budget-exceeded")
    candidates = [
        (p, "descendant", "root" if p.pid == root_pid else "child") for p in descendants.values()
    ]
    scanned = 0
    unavailable = 0
    for candidate in psutil.process_iter(["pid", "name", "uids"], ad_value=None):
        scanned += 1
        if scanned > 16384:
            raise AttributionError("process-enumeration-budget-exceeded")
        if candidate.pid in descendants or candidate.info["name"] not in WEBKIT_ROLES:
            continue
        if candidate.info["uids"] is None or candidate.info["uids"].real != uid:
            continue
        try:
            responsible = native.responsible(candidate.pid)
            if responsible != root_pid:
                continue
            role = webkit_role(candidate.exe())
            coalition = native.coalition(candidate.pid)
            if not service_matches(
                root_pid, root_coalition, responsible, coalition, candidate.uids().real, uid, role
            ):
                raise AttributionError("inconsistent-associated-service")
            candidates.append((candidate, "os-service", role))
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError):
            unavailable += 1
    if len(candidates) > 256:
        raise AttributionError("associated-process-budget-exceeded")
    rows = []
    for process, scope, role in candidates:
        try:
            identity = process.create_time()
            with process.oneshot():
                cpu = process.cpu_times()
                row = {
                    "pid": process.pid,
                    "creationTime": identity,
                    "scope": scope,
                    "role": role,
                    "rssBytes": process.memory_info().rss,
                    "threads": process.num_threads(),
                    "cpuSeconds": cpu.user + cpu.system,
                    "kernelCounters": sample_counters(process.pid),
                }
            if scope == "os-service" and (
                native.responsible(process.pid) != root_pid
                or native.coalition(process.pid) != root_coalition
            ):
                unavailable += 1
                continue
            if same_process(process.pid, identity):
                rows.append(row)
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError):
            unavailable += 1
    if (
        not same_process(root_pid, created)
        or native.responsible(root_pid) != root_pid
        or native.coalition(root_pid) != root_coalition
    ):
        raise AttributionError("root-identity-changed-during-sample")
    return rows, unavailable, root_coalition


def reduce_samples(samples):
    values = summarize({"samples": samples})
    for scope in ("descendant", "os-service"):
        values[scope] = {
            "peakRssBytes": max(
                (
                    sum(p["rssBytes"] for p in s["processes"] if p["scope"] == scope)
                    for s in samples
                ),
                default=None,
            ),
            "identities": len(
                {
                    (p["pid"], p["creationTime"])
                    for s in samples
                    for p in s["processes"]
                    if p["scope"] == scope
                }
            ),
        }
    values["memoryScope"] = "simultaneous-root-descendants-plus-attributed-webkit-xpcs"
    # Generic reducer's name is retained for compatibility but qualified explicitly.
    values["peakAttributedRssBytes"] = values.pop("peakTreeRssBytes")
    values["peakAttributedThreads"] = values.pop("peakTreeThreads")
    return values


def collect(pid, executable, seconds, interval=0.1):
    if not 1 <= seconds <= 10 or not 0.05 <= interval <= 0.5:
        raise AttributionError("invalid-sampling-bounds")
    process, created = verify(pid, executable)
    native = NativeQueries()
    start = time.monotonic()
    samples = []
    coalitions = set()
    while time.monotonic() - start < seconds:
        rows, unavailable, coalition = sample_group(process, created, executable, native)
        coalitions.add(coalition)
        samples.append(
            {
                "elapsedMs": (time.monotonic() - start) * 1000,
                "phase": "idle",
                "processes": rows,
                "rssBytes": sum(p["rssBytes"] for p in rows),
                "threads": sum(p["threads"] for p in rows),
                "unavailableAssociated": unavailable,
            }
        )
        time.sleep(interval)
    summary = reduce_samples(samples)
    expected_roles = set(WEBKIT_ROLES.values())
    covered = all(
        expected_roles <= {p["role"] for p in s["processes"] if p["scope"] == "os-service"}
        for s in samples
    )
    passed = (
        len(samples) >= 5
        and len(coalitions) == 1
        and summary["observed"]
        and covered
        and summary["sampledDurationMs"] >= seconds * 1000 * 0.75
        and not any(s["unavailableAssociated"] for s in samples)
    )
    return {
        "schema": 1,
        "provider": "darwin-responsibility-and-coalition-v1",
        "passed": passed,
        "rootPid": pid,
        "rootCreationTime": created,
        "selfResponsible": True,
        "separateFromObserver": True,
        "samples": samples,
        "summary": summary,
        "expectedServiceRolesPresent": covered,
        "limitations": [
            "Private query ABI: unavailable/ambiguous identity fails, never falls back to names",
            "Root verified by executable, creation time, self-responsibility and separate coalitions",
            "Only system WebKit XPCs with matching responsible PID, UID and both coalitions counted",
            "RSS is a simultaneous sum and may double-count shared pages, not unique physical RAM",
            "Sampled scope is not a claim to all OS services or complete process lifetimes",
            "No signals, priority changes, trust changes or process cleanup performed",
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pid", type=int)
    parser.add_argument("executable")
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    destination = Path(args.output)
    if destination.exists() or destination.is_symlink():
        raise SystemExit("Refusing existing observation output")
    try:
        result = collect(args.pid, args.executable, args.seconds)
    except (AttributionError, psutil.Error, OSError, ValueError) as error:
        result = {
            "schema": 1,
            "passed": False,
            "error": type(error).__name__,
            "reason": str(error)
            if isinstance(error, AttributionError)
            else "observation-unavailable",
        }
    with destination.open("x", encoding="utf8") as output:
        json.dump(result, output, indent=2)
        output.write("\n")
    print(
        json.dumps(
            {
                "passed": result["passed"],
                "reason": result.get("reason"),
                "summary": result.get("summary"),
            }
        )
    )
    raise SystemExit(0 if result["passed"] else 1)
