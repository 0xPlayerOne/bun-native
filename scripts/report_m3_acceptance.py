"""Verify retained M3 macOS evidence without inferring Windows/Linux runtime acceptance."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {"prebuilt", "development", "faults", "acquisition", "storage", "cef-identity"}


def require(value, message):
    if not value:
        raise ValueError(message)


def read_reports(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    require(manifest.get("schema") == 1, "Unknown evidence schema")
    reports = {}
    for entry in manifest["reports"]:
        name, filename = entry["name"], entry["path"]
        require(
            name in REQUIRED and name not in reports and filename == name + ".json.gz",
            "Invalid evidence member",
        )
        path = directory / filename
        require(
            not path.is_symlink() and path.stat().st_size <= 16 * 1024 * 1024,
            "Invalid stored report",
        )
        raw = path.read_bytes()
        require(
            hashlib.sha256(raw).hexdigest() == entry["storedSha256"], "Stored report hash mismatch"
        )
        with gzip.open(path, "rb") as source:
            plain = source.read(32 * 1024 * 1024 + 1)
        require(
            len(plain) <= 32 * 1024 * 1024 and len(plain) == entry["uncompressedBytes"],
            "Invalid expanded report size",
        )
        require(
            hashlib.sha256(plain).hexdigest() == entry["redactedSha256"],
            "Expanded report hash mismatch",
        )
        reports[name] = json.loads(plain)
    require(set(reports) == REQUIRED, "Incomplete M3 evidence inventory")
    return manifest, reports


def events(observation):
    values = []
    for line in observation.get("stdoutTail", []) + observation.get(
        "nativeDiagnostics", observation.get("stderr", [])
    ):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            values.append(value)
    return values


def clean_process(observation, expected_exit):
    require(observation.get("exitCode") == expected_exit, "Unexpected native process exit")
    for key in ("timedOut", "cancelled", "outputOverflow"):
        require(observation.get(key) is False, "Missing or failed process outcome: " + key)
    for key in ("observedOrphans", "cleanupSurvivors"):
        require(observation.get(key) == [], "Unverified native cleanup: " + key)


def smoke(observation):
    clean_process(observation, 0)
    data = events(observation)
    completed = [v for v in data if v.get("event") == "bunly.native.smoke"]
    require(
        len(completed) == 1 and completed[0].get("passed") is True,
        "Missing exact native completion",
    )
    record = completed[0]
    require(
        record.get("cycles") == 20 and type(record.get("timers")) is int and record["timers"] > 0,
        "Missing native workload",
    )
    require(
        all(record.get("diagnostics", {}).get(k) == 1 for k in ("windows", "views", "sessions")),
        "Resources did not converge",
    )
    require(
        any(v.get("event") == "bunly.host.shutdown" and v.get("clean") is True for v in data),
        "Missing clean host shutdown",
    )
    require(
        any(
            v.get("event") == "bunly.backend.exit"
            and v.get("code") == 0
            and v.get("forced") is False
            for v in data
        ),
        "Missing unforced backend exit",
    )
    require(
        not any(v.get("event") == "bunly.host.failure" for v in data), "Native failure cannot pass"
    )


def validate(manifest, reports, *, expected_identity=("154.0.34", "154.0.8037.98")):
    # This module replays frozen M3 evidence by default. Current-engine callers
    # must supply their independently pinned expected CEF/Chromium pair; never
    # infer the expected version from the report being validated.
    source = manifest["sourceCommit"]
    require(manifest.get("target") == "darwin-arm64", "Unexpected native target")
    prebuilt = reports["prebuilt"]
    require(
        prebuilt.get("passed") is True
        and prebuilt.get("noCompilerPath") is True
        and prebuilt.get("sourceArtifactUnchanged") is True,
        "Incomplete prebuilt acceptance",
    )
    for key in ("sourceBefore", "sourceAfter"):
        require(
            prebuilt[key].get("commit") == source and prebuilt[key].get("clean") is True,
            "Uncommitted native acceptance",
        )
    positives = {
        "installed-0",
        "installed-1",
        "installed-2",
        "last-window",
        "restored-installation",
    }
    negatives = {
        "rejected-4",
        "rejected-5",
        "rejected-6",
        "wrong-version",
        "missing-bun",
        "missing-helper",
    }
    seen = set()
    for trial in prebuilt["trials"]:
        name = trial["name"]
        require(name not in seen, "Duplicate native trial")
        seen.add(name)
        if name in positives:
            smoke(trial["observation"])
            if name == "last-window":
                require(
                    any(
                        v.get("event") == "bunly.native.last-window" and v.get("passed") is True
                        for v in events(trial["observation"])
                    ),
                    "No last-window completion",
                )
        else:
            require(name in negatives, "Unexpected negative native trial")
            clean_process(trial["observation"], 78)
            require(
                any(v.get("event") == "bunly.host.error" for v in events(trial["observation"])),
                "Missing startup rejection",
            )
    require(seen == positives | negatives, "Incomplete prebuilt trial matrix")
    development = reports["development"]
    require(
        development.get("passed") is True and development.get("deniedRequests") == 0,
        "Development origin policy failed",
    )
    clean_process(development["observation"], 0)
    faults = reports["faults"]
    expected_modes = {"backend-exit", "backend-tree-exit", "renderer-exit", "gpu-exit"}
    require(
        faults.get("passed") is True
        and len(faults["trials"]) == 4
        and {t["mode"] for t in faults["trials"]} == expected_modes,
        "Incomplete fault matrix",
    )
    for trial in faults["trials"]:
        mode = trial["mode"]
        require(trial.get("passed") is True, "Native fault failed")
        clean_process(trial["observation"], 0 if mode == "gpu-exit" else 1)
        data = events(trial["observation"])
        require(
            any(
                v.get("event") == "bunly.host.shutdown" and v.get("clean") is (mode == "gpu-exit")
                for v in data
            ),
            "Fault shutdown was not observed",
        )
        if mode in ("backend-exit", "backend-tree-exit"):
            require(
                any(
                    v.get("event") == "bunly.backend.exit"
                    and v.get("code") == 23
                    and v.get("forced") is False
                    for v in data
                ),
                "Actual backend failure not observed",
            )
        else:
            require(len(trial["injected"]) == 1, "Native helper fault was not injected")
    acquisition = reports["acquisition"]
    require(
        acquisition.get("passed") is True and acquisition.get("productionTrust") is False,
        "Wrong acquisition trust scope",
    )
    require(
        acquisition.get("sourceCommit") == source and acquisition.get("sourceClean") is True,
        "Uncommitted acquisition source",
    )
    require(
        acquisition.get("expandedTarBytes", 0) > 64 * 1024 * 1024
        and acquisition.get("requests") == 1,
        "Not a full-sized one-download acquisition",
    )
    for name in (
        "offlineCacheHit",
        "stableCacheInode",
        "leasedCleanupRejected",
        "compilerFreeChildPath",
        "cachedTamperRejected",
        "explicitCleanupVerified",
    ):
        require(acquisition.get(name) is True, "Missing acquisition property: " + name)
    offline = [c["observation"] for c in acquisition["commands"] if c["name"] == "native-offline"]
    require(len(offline) == 1, "Missing offline native execution")
    smoke(offline[0])
    storage = reports["storage"]
    require(
        storage.get("passed") is True and storage.get("volumeDetached") is True,
        "Storage qualification or volume cleanup failed",
    )
    require(
        storage.get("sourceCommit") == source and storage.get("sourceClean") is True,
        "Uncommitted storage source",
    )
    for name in (
        "passed",
        "preflightRejectedBeforeFetch",
        "partialWriteNeverPublished",
        "stagingCleaned",
        "recoveryPassed",
        "offlineReusePassed",
    ):
        require(
            storage["execution"].get(name) is True,
            "Missing disk failure/recovery acceptance: " + name,
        )
    identity = reports["cef-identity"]
    require(
        (identity.get("cefVersion"), identity.get("chromiumVersion")) == expected_identity
        and identity.get("source") == "exported-api",
        "Wrong loaded CEF identity",
    )
    return {
        "schema": 1,
        "target": "darwin-arm64",
        "passed": True,
        "sourceCommit": source,
        "prebuiltTrials": len(seen),
        "nativeLifecycleCycles": 20 * (len(positives) + 1),
        "faultCases": len(expected_modes),
        "forbiddenDevelopmentRequests": 0,
        "archiveBytes": acquisition["archiveBytes"],
        "expandedTarBytes": acquisition["expandedTarBytes"],
        "actualDiskFullRecovery": True,
        "compilerFreeOfflineNativeLaunch": True,
        "windowsNativeQualified": False,
        "linuxNativeQualified": False,
        "scope": "macOS native functional acceptance; no distribution signing or comparative performance claim",
    }


def verify(directory):
    manifest, reports = read_reports(directory)
    return validate(manifest, reports)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path, default=ROOT / "evidence/m3-macos")
    args = parser.parse_args()
    print(json.dumps(verify(args.directory), indent=2))
