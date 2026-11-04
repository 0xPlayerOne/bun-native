#!/usr/bin/env python3
"""Verify the retained #297 collection offline; never build or execute a workload."""

import argparse
import hashlib
import importlib.util
import io
import json
import math
import stat
import subprocess
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "bridge_pairs", ROOT / "benchmarks/bridge-pairs.py"
)
PAIRS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAIRS)
RECORD = ROOT / "benchmarks/evidence/bridge-pairs-41245052954.json"
require = PAIRS.require


def fingerprint(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def fields(record):
    return {key: record[key] for key in ("bytes", "sha256")}


class Archive:
    """Bounded ZIP reads in place: no extraction, symlinks or executable loading."""

    def __init__(self, path, expected):
        with path.open("rb") as stream:
            data = stream.read(8 * 1024 * 1024 + 1)
        require(len(data) <= 8 * 1024 * 1024, "Archive exceeds 8 MiB")
        require(fingerprint(data) == fields(expected), "Archive fingerprint differs")
        # Parse the exact hashed bytes, even if the caller replaces the file.
        self.buffer = io.BytesIO(data)
        try:
            self.archive = zipfile.ZipFile(self.buffer)
            entries = self.archive.infolist()
            require(len(entries) <= 2000, "Too many archive entries")
            require(
                sum(item.file_size for item in entries) <= 64 * 1024 * 1024,
                "Archive expands beyond 64 MiB",
            )
            require(
                len({item.filename for item in entries}) == len(entries),
                "Duplicate archive path",
            )
            for item in entries:
                path = PurePosixPath(item.filename)
                require(
                    not path.is_absolute()
                    and ".." not in path.parts
                    and "\\" not in item.filename
                    and not stat.S_ISLNK(item.external_attr >> 16),
                    "Unsafe archive path or symlink",
                )
                require(
                    item.file_size <= PAIRS.MAX_JSON_BYTES,
                    "Archive member exceeds 4 MiB",
                )
        except BaseException:
            if hasattr(self, "archive"):
                self.archive.close()
            self.buffer.close()
            raise

    def close(self):
        self.archive.close()
        self.buffer.close()

    def read(self, name):
        info = self.archive.getinfo(name)
        require(not info.is_dir(), "Expected a regular archive member")
        with self.archive.open(info) as stream:
            data = stream.read(PAIRS.MAX_JSON_BYTES + 1)
        require(len(data) == info.file_size, "Truncated or oversized archive member")
        return data

    def json(self, name):
        def finite_number(text):
            value = float(text)
            require(math.isfinite(value), "Non-finite JSON number")
            return value

        def invalid_constant(_text):
            raise ValueError("Non-finite JSON constant")

        return json.loads(
            self.read(name), parse_float=finite_number, parse_constant=invalid_constant
        )


class History:
    def __init__(self, repository):
        self.repository = repository

    def git(self, *arguments):
        result = subprocess.run(
            ["git", *arguments],
            cwd=self.repository,
            capture_output=True,
            timeout=15,
            check=True,
        )
        require(
            len(result.stdout) <= 4 * 1024 * 1024,
            "Historical source exceeds audit bound",
        )
        return result.stdout

    def blob(self, commit, path):
        return self.git("cat-file", "blob", f"{commit}:{path}")

    def sources(self, commit, records):
        require(
            len(records) == len({row["path"] for row in records}),
            "Duplicate source path",
        )
        for row in records:
            require(
                fingerprint(self.blob(commit, row["path"])) == fields(row),
                f"Historical source differs: {row['path']}",
            )

    def expected(self, commit):
        # This is the closed source contract of these two historical helpers.
        # Read Git blobs, not the current worktree or an installed dependency.
        paths = set(
            self.git("ls-tree", "-r", "--name-only", commit).decode().splitlines()
        )
        required = {
            "examples/native-window/main.ts",
            "examples/native-window/content.ts",
            "package.json",
            "bun.lock",
            "bunfig.toml",
            "tsconfig.json",
            "packages/protocol/package.json",
            "packages/runtime/package.json",
            "packages/core/package.json",
            ".bun-version",
            "rust-toolchain.toml",
            "toolchain.json",
            "Cargo.toml",
            "Cargo.lock",
            "native/gpui-host/Cargo.toml",
            "native/protocol/Cargo.toml",
            "benchmarks/bridge.ts",
        }
        prefixes = (
            ("packages/protocol/src/", ".ts"),
            ("packages/runtime/src/", ".ts"),
            ("packages/core/src/", ".ts"),
            ("native/gpui-host/src/", ".rs"),
            ("native/protocol/src/", ".rs"),
        )
        required.update(
            path
            for path in paths
            if any(path.startswith(p) and path.endswith(s) for p, s in prefixes)
        )
        compiler = {
            path
            for path in paths
            if path.startswith("experiments/aot-gpui/")
            and path.endswith(".ts")
            and not path.endswith(".test.ts")
        }
        return required, required | compiler


def verify_plan(summary, plan, build):
    require(
        summary["status"] == build["status"] == "passed",
        "Incomplete collection or build",
    )
    require(
        summary["plan"] == plan["plan"] == PAIRS.plan_trials(5, 1),
        "Changed or incomplete declared plan",
    )
    require(
        summary["build"] == plan["build"],
        "Plan and collection used different build records",
    )
    require(
        summary["methodology"] == plan["methodology"],
        "Methodology changed after planning",
    )
    require(
        summary["controller"] == plan["controller"] == build["controller"],
        "Controller changed after build",
    )
    require(
        datetime.fromisoformat(build["finished_at"])
        <= datetime.fromisoformat(summary["started_at"]),
        "Compilation overlapped collection",
    )
    trials = summary["trials"]
    require(len(trials) == len(plan["plan"]), "Missing or extra trial")
    previous_end = datetime.fromisoformat(summary["started_at"])
    for expected, trial in zip(plan["plan"], trials, strict=True):
        require(
            all(trial[key] == value for key, value in expected.items()),
            "Trial order differs from the saved plan",
        )
        require(
            trial["status"] == "passed",
            "Failed observation cannot qualify a complete collection",
        )
        supervisor = trial["supervisor"]
        start = datetime.fromisoformat(supervisor["started_at"])
        end = datetime.fromisoformat(supervisor["finished_at"])
        require(
            previous_end <= start <= end, "Trials overlap or timestamps go backwards"
        )
        previous_end = end


def verify_variant(archive, history, name, variant, expected):
    commit = PAIRS.VARIANTS[name]["commit"]
    require(
        variant["source"]["commit"] == expected["commit"] == commit,
        "Wrong historical revision",
    )
    path = f"prepared/{name}/package/manifest.json"
    require(
        fingerprint(archive.read(path)) == variant["manifest"] == expected["manifest"],
        "AOT manifest fingerprint differs",
    )
    manifest = archive.json(path)
    application_sources, build_sources = history.expected(commit)
    require(
        {row["path"] for row in manifest["source"]["files"]} == application_sources,
        "Incomplete AOT source set",
    )
    require(
        {row["path"] for row in variant["source"]["files"]} == build_sources,
        "Incomplete build source set",
    )
    history.sources(commit, variant["source"]["files"])
    history.sources(commit, manifest["source"]["files"])
    require(
        manifest["source"]["commit"] == commit and manifest["source"]["dirty"] is False,
        "Dirty or mismatched AOT source",
    )
    require(
        manifest["toolchain"]
        == variant["toolchain"]
        == json.loads(history.blob(commit, "toolchain.json")),
        "Toolchain differs from its historical source",
    )
    require(manifest["entrypoint"] == "benchmarks/bridge.ts", "Wrong compiled entry")
    require(
        manifest["host"]["profile"] == "release"
        and manifest["host"]["placement"] == "external"
        and manifest["host"]["file"] == variant["host_path"],
        "Wrong native host placement/profile",
    )
    for field in ("application", "host"):
        require(
            fields(manifest[field]) == variant[field] == expected[field],
            "Recorded artifact identities differ",
        )
    require(
        manifest["application"]["inspection"]["hasCompiledProgram"] is True,
        "Missing compiled-program inspection",
    )
    require(
        manifest["verification"]["aotCompiledProgram"]
        == manifest["verification"]["jitOmission"]
        == "passed",
        "AOT verification failed",
    )
    features = manifest["application"]["runtimeFeatures"]
    require(
        features["jit"] == "unused" and features["jitRemovedRanges"]["count"] == 27,
        "Missing exact inspected JIT removal evidence",
    )
    require(
        [step["name"] for step in variant["steps"]]
        == ["dependencies", "release-host", "aot"],
        "Missing build steps",
    )
    require(
        all(step["result"]["status"] == "passed" for step in variant["steps"]),
        "A build step failed",
    )
    return manifest


def verify_trials(archive, summary, build, manifests):
    for trial in summary["trials"]:
        prefix = f"observations/{trial['id']}"
        raw_path = f"{prefix}/workload/result.json"
        require(
            fingerprint(archive.read(raw_path)) == fields(trial["raw_result"]),
            "Raw observation fingerprint differs",
        )
        result = archive.json(raw_path)
        require(
            PAIRS.verify_result(result, trial, build, manifests[trial["variant"]])
            == trial["metrics"],
            "Derived metrics differ from raw observations",
        )
        supervisor = archive.json(f"{prefix}/process/supervisor.json")
        require(
            supervisor == trial["supervisor"] and supervisor["status"] == "passed",
            "Supervisor record differs",
        )
        require(
            supervisor["cleanup"]
            == {
                "forced_termination": False,
                "remaining_observed_pids": [],
                "unreaped_observed_pids": [],
                "application_exit_code": 0,
            },
            "Observation required forced or incomplete cleanup",
        )
        observed = supervisor["observed_native_processes"]
        require(len(observed) == 1, "Missing or duplicate observed native identity")
        for identity in observed.values():
            require(
                type(identity["start_ticks"]) is int
                and identity["start_ticks"] > 0
                and identity["executable"]
                == build["variants"][trial["variant"]]["host_path"],
                "Owned native identity differs",
            )
        for stream in ("stdout", "stderr"):
            require(
                supervisor["logs"][stream]
                == {
                    "written_bytes": len(
                        archive.read(f"{prefix}/process/{stream}.log")
                    ),
                    "discarded_bytes": 0,
                },
                "Captured log was truncated or changed",
            )
        require(
            result["display"]
            == {
                "x11": summary["display"]["DISPLAY"],
                "wayland": summary["display"]["WAYLAND_DISPLAY"],
                "vulkanDriverFiles": summary["display"]["VK_DRIVER_FILES"],
                "softwareGlRequested": summary["display"]["LIBGL_ALWAYS_SOFTWARE"],
            },
            "Display configuration changed between observations",
        )
    require(
        PAIRS.paired_summary(summary["trials"]) == summary["paired"],
        "Paired summary differs from the retained observations",
    )


def verify_validation_failure(archive, expected):
    require(
        archive.read("toolchain.txt").decode().splitlines()[0]
        == expected["testedMerge"],
        "Validation used another source",
    )
    host_hash = archive.read("binary-sha256.txt").decode().split()[0]
    require(host_hash == expected["nativeHost"]["sha256"], "Validation host differs")
    require(
        archive.read("binary-size.txt").decode().strip()
        == f"{expected['nativeHost']['bytes']} bytes",
        "Validation host size differs",
    )
    records = [
        json.loads(line)
        for line in archive.read("development/lifecycle-events.jsonl").splitlines()
    ]
    require(
        len(records) == 21 and len({row["nonce"] for row in records}) == 1,
        "Incomplete or mixed startup trace",
    )
    native = [row for row in records if row["source"] == "native"]
    require(
        [row["phase"] for row in native] == ["open_dispatched", "open_window_enter"],
        "Failure phase differs",
    )
    require(
        all(row["request_id"] == 3 and row["window_id"] == 1 for row in native),
        "Wrong failing window/request",
    )
    transport = [row for row in records if row["source"] == "transport"]
    require(
        [
            (row["request_id"], row["response"])
            for row in transport
            if row["phase"] == "response_received"
        ]
        == [(1, "ack"), (2, "error")],
        "Earlier handshake/ownership responses differ",
    )
    failed = [row for row in transport if row["phase"] == "transport_failed"]
    require(
        len(failed) == 1
        and failed[0]["error"] == "Native open request 3 timed out"
        and failed[0]["stderr_tail"] == "",
        "Original timeout evidence differs",
    )


def compact_comparisons(paired):
    selected = ("individual.p95Ms", "individual.totalMs", "batchesOf100.totalMs")
    return {
        mode: {
            "complete_pairs": row["complete_pairs"],
            "medians": {
                metric: {
                    key: values[key]
                    for key in ("median_paired_difference", "median_paired_ratio")
                }
                for metric, values in row["comparisons"].items()
            },
            "selected_pairs": {
                metric: {
                    variant: [
                        pair[variant] for pair in row["comparisons"][metric]["pairs"]
                    ]
                    for variant in PAIRS.VARIANTS
                }
                for metric in selected
            },
        }
        for mode, row in paired.items()
    }


def audit(paired_path, validation_path, repository, record):
    require(record["schemaVersion"] == 1, "Unsupported evidence record schema")
    paired = Archive(paired_path, record["collection"]["artifact"])
    try:
        validation = Archive(
            validation_path, record["requiredValidationFailure"]["artifact"]
        )
        try:
            history = History(repository)
            tested_merge = record["collection"]["testedMerge"]
            require(
                history.git("rev-parse", f"{tested_merge}^{{tree}}").decode().strip()
                == record["collection"]["testedTree"],
                "Tested merge tree differs",
            )
            summary = paired.json("observations/summary.json")
            plan = paired.json("observations/plan.json")
            build = paired.json("prepared/build.json")
            verify_plan(summary, plan, build)
            require(
                fingerprint(paired.read("prepared/build.json"))
                == fields(summary["build"]),
                "Build receipt differs",
            )
            require(summary["machine"] == record["machine"], "Machine record differs")
            for observed, expected in zip(
                build["controller"], record["controllerFiles"], strict=True
            ):
                require(
                    observed
                    == {key: expected[key] for key in ("path", "bytes", "sha256")},
                    "Controller receipt differs",
                )
                data = history.git("cat-file", "blob", expected["gitBlob"])
                require(
                    history.git("rev-parse", f"{tested_merge}:{expected['path']}")
                    .decode()
                    .strip()
                    == expected["gitBlob"],
                    "Controller blob does not belong to the tested merge",
                )
                require(
                    fingerprint(data) == fields(expected), "Controller Git blob differs"
                )
            require(set(build["variants"]) == set(PAIRS.VARIANTS), "Wrong variant set")
            manifests = {
                name: verify_variant(
                    paired, history, name, variant, record["variants"][name]
                )
                for name, variant in build["variants"].items()
            }
            require(
                manifests["bn1"]["toolchain"] == manifests["events"]["toolchain"],
                "Variants use different pinned toolchains",
            )
            verify_trials(paired, summary, build, manifests)
            require(
                compact_comparisons(summary["paired"]) == record["paired"],
                "Committed comparison differs from raw evidence",
            )
            raw_receipts = [
                {"id": row["id"], **fields(row["raw_result"])}
                for row in summary["trials"]
            ]
            require(
                raw_receipts == record["rawObservations"],
                "Committed observation receipts differ",
            )
            require(
                len(
                    [
                        name
                        for name in paired.archive.namelist()
                        if name.endswith("/workload/result.json")
                    ]
                )
                == 24,
                "Unexpected extra observation",
            )
            verify_validation_failure(validation, record["requiredValidationFailure"])
            return {
                "status": "passed",
                "operation": "offline retained-evidence audit",
                "collectionRun": record["collection"]["runId"],
                "warmups": 4,
                "measuredTrials": 20,
                "pairsPerMode": 5,
                "individualSamples": 24000,
                "batchSamples": 240,
                "sourceBlobsVerified": True,
                "rawMetricsRecomputed": True,
                "originalValidationFailurePreserved": True,
                "binaryReinspection": "not performed; uploaded archives omit executable bytes",
                "workloadExecutions": 0,
            }
        finally:
            validation.close()
    finally:
        paired.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paired-artifact", type=Path, required=True)
    parser.add_argument("--validation-artifact", type=Path, required=True)
    parser.add_argument("--repository", type=Path, default=ROOT)
    args = parser.parse_args()
    result = audit(
        args.paired_artifact,
        args.validation_artifact,
        args.repository,
        PAIRS.read_json(RECORD),
    )
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
