"""Optional, read-only OS counters. Never substitutes context switches for wakeups.

Linux fields: torvalds/linux v6.8 kernel/sched/debug.c proc_sched_show_task.
Darwin ABI: apple-oss-distributions/xnu bsd/sys/resource.h rusage_info_v0.
These counters have different semantics and must not be compared across providers.
"""

import ctypes
import os
import re
import sys
from pathlib import Path


class RusageV0(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "user_time",
            "system_time",
            "pkg_idle_wkups",
            "interrupt_wkups",
            "pageins",
            "wired_size",
            "resident_size",
            "phys_footprint",
            "proc_start_abstime",
            "proc_exit_abstime",
        )
    ]


def unavailable(provider, reason):
    return {
        "provider": provider,
        "status": "unavailable",
        "reason": reason,
        "counters": [],
        "expectedScopes": 0,
        "sampledScopes": 0,
    }


def parse_sched(text):
    result = {}
    for line in text.splitlines():
        match = re.fullmatch(
            r"\s*(?:se\.statistics\.)?(nr_wakeups|nr_wakeups_idle)\s*:\s*(\d+)\s*", line
        )
        if match:
            if match[1] in result:
                raise ValueError("Duplicate scheduler counter")
            result[match[1]] = int(match[2])
    return result


def task_start(text):
    # comm may itself contain spaces or closing parentheses; fields after the
    # last ')' start at field 3. starttime is field 22, index 19 in this tail.
    fields = text[text.rfind(")") + 2 :].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise ValueError("Invalid task identity")
    return fields[19]


def linux_sample(pid, proc_root=Path("/proc")):
    provider = "linux-proc-sched-v1"
    tasks = proc_root / str(pid) / "task"
    try:
        paths = [path for path in tasks.iterdir() if path.name.isdigit()]
        if not paths or len(paths) > 4096:
            return unavailable(provider, "No task identities or task budget exceeded")
        values = []
        sampled = 0
        for path in paths:
            try:
                before = task_start((path / "stat").read_text())
                counters = parse_sched((path / "sched").read_text())
                after = task_start((path / "stat").read_text())
                if before != after or "nr_wakeups" not in counters:
                    continue
                scope = f"{path.name}:{before}"
                values.append(
                    {"name": "schedulerWakeups", "scope": scope, "value": counters["nr_wakeups"]}
                )
                if "nr_wakeups_idle" in counters:
                    values.append(
                        {
                            "name": "schedulerIdleWakeups",
                            "scope": scope,
                            "value": counters["nr_wakeups_idle"],
                        }
                    )
                sampled += 1
            except (OSError, ValueError):
                continue
        if not sampled:
            return unavailable(
                provider,
                "nr_wakeups unavailable: CONFIG_SCHEDSTATS/runtime schedstats or access required",
            )
        return {
            "provider": provider,
            "status": "available" if sampled == len(paths) else "partial",
            "reason": "Per-task scheduler wakeups, not package power-state exits; idle subtype is scheduler-defined",
            "counters": values,
            "expectedScopes": len(paths),
            "sampledScopes": sampled,
        }
    except OSError as error:
        return unavailable(provider, f"Cannot read owned task counters: {error.__class__.__name__}")


_darwin_function = None


def darwin_sample(pid):
    global _darwin_function
    provider = "darwin-proc-rusage-v0"
    try:
        if ctypes.sizeof(RusageV0) != 96:
            return unavailable(provider, "Unexpected rusage_info_v0 layout")
        if _darwin_function is None:
            library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            function = library.proc_pid_rusage
            function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
            function.restype = ctypes.c_int
            _darwin_function = function
        usage = RusageV0()
        if _darwin_function(pid, 0, ctypes.byref(usage)) != 0:
            return unavailable(
                provider, f"proc_pid_rusage denied/exited: errno {ctypes.get_errno()}"
            )
        scope = f"{pid}:{usage.proc_start_abstime}"
        return {
            "provider": provider,
            "status": "available",
            "reason": "Kernel-attributed package-idle and interrupt wakeups; not Linux scheduler wakeups",
            "counters": [
                {"name": "packageIdleWakeups", "scope": scope, "value": usage.pkg_idle_wkups},
                {"name": "interruptWakeups", "scope": scope, "value": usage.interrupt_wkups},
            ],
            "expectedScopes": 1,
            "sampledScopes": 1,
        }
    except (OSError, AttributeError) as error:
        return unavailable(provider, f"proc_pid_rusage unavailable: {error.__class__.__name__}")


def sample_counters(pid):
    if os.getenv("BUNLY_KERNEL_COUNTERS") != "1":
        return unavailable(
            "disabled", "Opt in with BUNLY_KERNEL_COUNTERS=1; collection adds observer overhead"
        )
    if sys.platform == "linux":
        return linux_sample(pid)
    if sys.platform == "darwin":
        return darwin_sample(pid)
    return unavailable(
        "windows-etw-not-implemented",
        "No qualified Windows ETW collector; no fallback to context switches",
    )


def summarize_counters(samples):
    """Deltas only across adjacent same-phase observations of the same identity.

    New/exited tasks and phase boundaries are deliberately omitted, making this
    observed lower-bound accounting rather than a complete lifetime counter.
    """
    groups = {}
    reasons = set()
    for sample in samples:
        for row in sample["processes"]:
            counters = row.get("kernelCounters", unavailable("legacy", "Not collected"))
            if counters["status"] != "available":
                reasons.add(counters["provider"] + ": " + counters["reason"])
    for previous, current in zip(samples, samples[1:], strict=False):
        seconds = (current["elapsedMs"] - previous["elapsedMs"]) / 1000
        if seconds <= 0:
            raise ValueError("Non-monotonic counter observations")
        if previous["phase"] != current["phase"]:
            continue
        old = {(row["pid"], row.get("creationTime")): row for row in previous["processes"]}
        # One wall-clock interval per provider/metric, not one per thread.
        intervals = set()
        for row in current["processes"]:
            prior = old.get((row["pid"], row.get("creationTime")))
            if prior is None:
                continue
            a, b = prior.get("kernelCounters"), row.get("kernelCounters")
            if not a or not b or a["provider"] != b["provider"]:
                continue
            prior_values = {
                (counter["name"], counter["scope"]): counter["value"] for counter in a["counters"]
            }
            for counter in b["counters"]:
                initial = prior_values.get((counter["name"], counter["scope"]))
                if initial is None:
                    continue
                delta = counter["value"] - initial
                if delta < 0:
                    reasons.add(b["provider"] + ": counter reset; affected delta omitted")
                    continue
                key = (current["phase"], b["provider"], counter["name"])
                group = groups.setdefault(
                    key,
                    {
                        "phase": key[0],
                        "provider": key[1],
                        "metric": key[2],
                        "observedDelta": 0,
                        "sampledDurationMs": 0,
                        "matchedScopeIntervals": 0,
                    },
                )
                group["observedDelta"] += delta
                group["matchedScopeIntervals"] += 1
                intervals.add(key)
        for key in intervals:
            groups[key]["sampledDurationMs"] += seconds * 1000
    return {
        "status": "observed" if groups else "unavailable",
        "metrics": list(groups.values()),
        "limitations": sorted(reasons),
        "accounting": "Adjacent matched identities only; excludes observer; misses new/exited tasks and phase boundaries. Providers are not interchangeable.",
    }
