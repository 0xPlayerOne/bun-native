"""Verify native Windows/Linux functional evidence without promoting emulated timings."""

import argparse
import gzip
import hashlib
import json
import re
from pathlib import Path

from report_m3_acceptance import clean_process, events, require, smoke

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {"prebuilt", "development", "faults", "identity", "environment"}
POSITIVES = {"installed-0", "installed-1", "installed-2", "last-window", "restored-installation"}
REJECTIONS = {
    "rejected-4": "Unsafe command-line",
    "rejected-5": "Unsafe command-line",
    "rejected-6": "Unsafe command-line",
    "wrong-version": "Runtime/ABI manifest mismatch",
    "missing-bun": "Installed Bun or backend missing",
}
FAULTS = {"backend-exit", "backend-tree-exit", "renderer-exit", "gpu-exit"}


def isolation(observation, target):
    """Count observed identities, not continuous or equivalent sandbox policies.

    Linux renderer children can retain their zygote argv. Do not fabricate renderer
    classification from process names; retain the actual OS-isolated descendants.
    """
    field = "linuxSandbox" if target == "linux-x64" else "windowsSandbox"
    provider = "linux-proc-status-v1" if target == "linux-x64" else "windows-token-job-v1"
    isolated, observed, roles = set(), set(), set()
    for sample in observation.get("samples", []):
        for row in sample.get("processes", []):
            identity = (row.get("pid"), row.get("creationTime"))
            state = row.get(field, {})
            if state.get("provider") != provider or state.get("available") is not True:
                continue
            require(type(identity[0]) is int and identity[0] > 0, "Missing process identity")
            require(
                type(identity[1]) in (int, float) and identity[1] > 0, "Missing process lifetime"
            )
            observed.add(identity)
            if state.get("isolationObserved") is True:
                if target == "linux-x64":
                    require(
                        state.get("seccompFilter") is True
                        and state.get("noNewPrivileges") is True
                        and state.get("effectiveCapabilitiesZero") is True
                        and type(state.get("namespacePidDepth")) is int
                        and state["namespacePidDepth"] > 1,
                        "Contradictory Linux isolation evidence",
                    )
                else:
                    require(
                        type(state.get("integrityRid")) is int
                        and 0 <= state["integrityRid"] <= 0x1000
                        and (
                            state.get("restrictedSids") is True or state.get("appContainer") is True
                        )
                        and state.get("inJob") is True,
                        "Contradictory Windows isolation evidence",
                    )
                isolated.add(identity)
                if row.get("browserRole") is not None:
                    roles.add(row["browserRole"])
    require(isolated, "No native isolated browser descendant was observed")
    return {
        "observedIdentities": len(observed),
        "isolatedIdentities": len(isolated),
        "argvRoles": sorted(roles),
    }


def validate(target, profile, reports, *, expected_identity=("154.0.34", "154.0.8037.98")):
    # Historical replay stays pinned to the engine actually measured. Hosted
    # current-engine qualification supplies a separate expected pair explicitly.
    require(target in ("linux-x64", "win32-x64"), "Unsupported native platform")
    require(profile in ("standard", "emulated-functional"), "Unknown deadline profile")
    require(set(reports) == REQUIRED, "Incomplete native platform evidence")
    prebuilt = reports["prebuilt"]
    require(
        prebuilt.get("target") == target and prebuilt.get("passed") is True,
        "Wrong/failed prebuilt target",
    )
    require(prebuilt.get("deadlineProfile") == profile, "Wrong prebuilt deadline profile")
    require(
        prebuilt.get("noCompilerPath") is True and prebuilt.get("sourceArtifactUnchanged") is True,
        "Prebuilt isolation not established",
    )
    negative = dict(REJECTIONS)
    if target == "linux-x64":
        negative["missing-display"] = "requires an X11 DISPLAY"
        negative["missing-cef-library"] = "loader"
    expected = POSITIVES | set(negative)
    seen, security = set(), {}
    for trial in prebuilt["trials"]:
        name, observation = trial["name"], trial["observation"]
        require(name in expected and name not in seen, "Duplicate or undeclared native trial")
        seen.add(name)
        if name in POSITIVES:
            smoke(observation)
            completed = [r for r in events(observation) if r.get("event") == "bunly.native.smoke"][
                0
            ]
            require(
                completed["diagnostics"].get("deadlineProfile") == profile,
                "Native profile not attested",
            )
            security[name] = isolation(observation, target)
            if name == "last-window":
                require(
                    any(
                        r.get("event") == "bunly.native.last-window" and r.get("passed") is True
                        for r in events(observation)
                    ),
                    "Last-window exit not observed",
                )
        elif name == "missing-cef-library":
            clean_process(observation, 127)
            require(not events(observation), "Missing library must fail before host startup")
            require(
                any(
                    re.search(r"libcef\.so.*cannot open shared object file", line)
                    for line in observation["stderr"]
                ),
                "Missing actual loader diagnostic",
            )
        else:
            clean_process(observation, 78)
            require(
                any(
                    r.get("event") == "bunly.host.error"
                    and negative[name] in str(r.get("error", ""))
                    for r in events(observation)
                ),
                "Wrong native startup rejection",
            )
    require(seen == expected, "Incomplete prebuilt trial matrix")
    development = reports["development"]
    require(
        development.get("target") == target and development.get("deadlineProfile") == profile,
        "Wrong development target/profile",
    )
    require(
        development.get("passed") is True and development.get("deniedRequests") == 0,
        "Development resource policy failed",
    )
    clean_process(development["observation"], 0)
    require(
        any(
            r.get("event") == "bunly.native.development" and r.get("passed") is True
            for r in events(development["observation"])
        ),
        "Missing native development completion",
    )
    faults = reports["faults"]
    require(
        faults.get("platform") == target.split("-")[0] and faults.get("deadlineProfile") == profile,
        "Wrong fault platform/profile",
    )
    require(faults.get("passed") is True and len(faults["trials"]) == 4, "Incomplete native faults")
    require({t["mode"] for t in faults["trials"]} == FAULTS, "Missing or duplicate native fault")
    for trial in faults["trials"]:
        mode, observation = trial["mode"], trial["observation"]
        require(trial.get("passed") is True, "Native fault failed")
        clean_process(observation, 0 if mode == "gpu-exit" else 1)
        records = events(observation)
        require(
            any(r.get("event") == "bunly.fault.ready" and r.get("mode") == mode for r in records),
            "Fault before fixture readiness",
        )
        require(
            any(
                r.get("event") == "bunly.host.shutdown" and r.get("clean") is (mode == "gpu-exit")
                for r in records
            ),
            "Unverified fault shutdown",
        )
        if mode in ("backend-exit", "backend-tree-exit"):
            require(
                any(
                    r.get("event") == "bunly.backend.exit"
                    and r.get("code") == 23
                    and r.get("forced") is False
                    for r in records
                ),
                "Backend failure not observed",
            )
        else:
            require(len(trial["injected"]) == 1, "Missing actual native helper fault")
            injection = trial["injected"][0]
            require(
                injection.get("role") == ("gpu-process" if mode == "gpu-exit" else "renderer")
                and type(injection.get("pid")) is int
                and injection["pid"] > 0,
                "Wrong native helper was targeted",
            )
            if mode == "gpu-exit":
                require(
                    any(
                        r.get("event") == "bunly.native.gpu-injection-acknowledged"
                        and r.get("passed") is True
                        for r in records
                    ),
                    "Recovery was not gated on actual GPU injection",
                )
            event = (
                "bunly.native.gpu-recovered"
                if mode == "gpu-exit"
                else "bunly.native.renderer-failure-observed"
            )
            require(
                any(r.get("event") == event and r.get("passed") is True for r in records),
                "Missing native helper failure/recovery acknowledgement",
            )
    identity = reports["identity"]
    require(
        identity.get("source") == "exported-api"
        and (identity.get("cefVersion"), identity.get("chromiumVersion")) == expected_identity,
        "Wrong actual CEF identity",
    )
    require(
        re.fullmatch(r"[a-f0-9]{64}", str(identity.get("sha256", ""))), "Missing CEF binary digest"
    )
    environment = reports["environment"]
    require(
        environment.get("target") == target and environment.get("standardUser") is True,
        "Missing unprivileged native environment",
    )
    require(environment.get("bunVersion") == "1.4.3", "Wrong native Bun runtime")
    require(
        environment.get("emulated") is (profile == "emulated-functional"), "Emulation not declared"
    )
    return {
        "schema": 1,
        "target": target,
        "deadlineProfile": profile,
        "passed": True,
        "prebuiltTrials": len(seen),
        "lifecycleCycles": 20 * len(POSITIVES),
        "faultCases": 4,
        "forbiddenDevelopmentRequests": 0,
        "isolationObservations": security,
        "performanceQualified": False,
        "hardwareGpuQualified": False,
        "physicalInputDpiQualified": False,
    }


def verify(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    require(manifest.get("schema") == 1, "Wrong platform manifest schema")
    require(
        re.fullmatch(r"[a-f0-9]{40}", str(manifest.get("sourceCommit", ""))),
        "Unpinned execution source",
    )
    reports = {}
    for entry in manifest["reports"]:
        name = entry["name"]
        require(
            name in REQUIRED and name not in reports and entry["path"] == name + ".json.gz",
            "Invalid report inventory",
        )
        path = directory / entry["path"]
        require(
            not path.is_symlink() and path.is_file() and path.stat().st_size <= 32 * 1024**2,
            "Invalid stored report",
        )
        stored = path.read_bytes()
        require(
            hashlib.sha256(stored).hexdigest() == entry["storedSha256"],
            "Stored report hash mismatch",
        )
        with gzip.open(path, "rb") as stream:
            plain = stream.read(128 * 1024**2 + 1)
        require(
            len(plain) <= 128 * 1024**2 and len(plain) == entry["uncompressedBytes"],
            "Invalid expanded report size",
        )
        require(
            hashlib.sha256(plain).hexdigest() == entry["redactedSha256"],
            "Expanded report hash mismatch",
        )
        reports[name] = json.loads(plain)
    return validate(manifest["target"], manifest["deadlineProfile"], reports)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    options = parser.parse_args()
    print(json.dumps(verify(options.directory), indent=2))
