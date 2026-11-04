#!/usr/bin/env python3
"""Prepare fixed-region diagnostic patches; never modify historical originals."""

import argparse
import difflib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PAIRS = load("allocation_pairs", ROOT / "benchmarks/bridge-pairs.py")
BASELINE = PAIRS.BASELINE
require = PAIRS.require
fingerprint = BASELINE.fingerprint
CRATE = ROOT / "experiments/native-allocation-api"
ADAPTER = ROOT / "benchmarks/native-allocations/host.rs"
CFG = "bun_native_allocation_diagnostic"
MODIFIED = {
    "native/gpui-host/src/main.rs",
    "native/gpui-host/src/session.rs",
    "native/gpui-host/src/view.rs",
    "native/gpui-host/src/allocation.rs",
}
PHASES = {
    "individual": {"firstRequest": 48, "lastRequest": 1047, "operationsPerCommand": 1},
    "batch": {"firstRequest": 1048, "lastRequest": 1057, "operationsPerCommand": 100},
}


def replace_once(source, old, new):
    require(source.count(old) == 1, "Historical patch anchor is missing or ambiguous")
    return source.replace(old, new, 1)


def patch_sources(files, adapter):
    result = dict(files)
    main = replace_once(
        result["native/gpui-host/src/main.rs"],
        "mod channel;",
        f"#[cfg({CFG})]\nmod allocation;\nmod channel;",
    )
    main = replace_once(
        main,
        "fn main() {\n",
        f"fn main() {{\n    #[cfg({CFG})]\n    allocation::initialize();\n",
    )
    result["native/gpui-host/src/main.rs"] = replace_once(
        main,
        "        });\n}\n",
        f"        }});\n    #[cfg({CFG})]\n    allocation::finish();\n}}\n",
    )
    prepare = "        let prepared = state\n            .borrow()\n            .tree\n            .prepare(base_revision, operations, self.last_node_id);"
    session = replace_once(
        result["native/gpui-host/src/session.rs"],
        prepare,
        f"        #[cfg({CFG})]\n        crate::allocation::before(id, window_id, base_revision, &operations, &state.borrow().tree);\n"
        + prepare,
    )
    boundary = "        let result = handle.update(cx, |view, window, cx| view.apply(prepared.tree, window, cx));\n"
    result["native/gpui-host/src/session.rs"] = replace_once(
        session,
        boundary,
        "        let result = handle.update(cx, |view, window, cx| {\n"
        "            view.apply(prepared.tree, window, cx);\n"
        f"            #[cfg({CFG})]\n            crate::allocation::after(id, true);\n"
        "        });\n"
        f"        #[cfg({CFG})]\n        if result.is_err() {{ crate::allocation::after(id, false); }}\n",
    )
    render = "    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {\n"
    result["native/gpui-host/src/view.rs"] = replace_once(
        result["native/gpui-host/src/view.rs"],
        render,
        render
        + f"        #[cfg({CFG})]\n        crate::allocation::render(self.window_id);\n",
    )
    result["native/gpui-host/src/allocation.rs"] = adapter
    return result


def diagnostic_sources():
    paths = {
        "benchmarks/allocation-phases.py",
        "benchmarks/native-allocation-control.py",
        "benchmarks/bridge-pairs.py",
        "benchmarks/native-baseline.py",
        "scripts/quality/native-input-linux.py",
        "scripts/quality/native-linux-session.sh",
        "scripts/quality/native-allocation-linux.py",
        "benchmarks/native-allocations/host.rs",
    }
    paths.update(
        path.relative_to(ROOT).as_posix()
        for path in CRATE.rglob("*")
        if path.is_file() and path.suffix in (".rs", ".toml", ".lock")
    )
    return [{"path": path, **fingerprint(ROOT / path)} for path in sorted(paths)]


def compiler_flags(rlib):
    require(
        rlib.is_absolute() and rlib.is_file(), "The exact diagnostic rlib is required"
    )
    return [
        "--extern",
        f"bun_native_allocation_diagnostic={rlib}",
        "--cfg",
        CFG,
        "--check-cfg",
        f"cfg({CFG})",
        "-C",
        "debuginfo=1",
        "-C",
        "strip=none",
    ]


def validate_region(value, phase, nonce, source, build, pid):
    fixed = PHASES[phase]
    require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["status"] == "complete"
        and value["nonce"] == nonce
        and value["source"] == source
        and value["buildId"] == build
        and type(value["pid"]) is int
        and value["pid"] == pid
        and value["phase"] == phase,
        "Native region identity/completion mismatch",
    )
    require(
        all(
            type(value[key]) is int and value[key] == expected
            for key, expected in fixed.items()
        ),
        "Fixed workload changed",
    )
    require(
        type(value["appliedCommands"]) is int
        and value["appliedCommands"]
        == fixed["lastRequest"] - fixed["firstRequest"] + 1,
        "Selected interval is incomplete",
    )
    for key in ("rootRenderEntries", "otherWindowRenderEntries", "intervalNanoseconds"):
        require(
            type(value[key]) is int and 0 <= value[key] < 1 << 63,
            "Invalid native counter",
        )
    require(
        value["scope"] == "whole-native-process-allocations-during-selected-interval",
        "Wrong allocation scope",
    )


def prepare_patch(source, variant, qualification, output):
    require(qualification["status"] == "passed", "Actual FFI control must pass first")
    require(
        qualification["sources"] == diagnostic_sources(),
        "Diagnostic source changed after control",
    )
    rlib = Path(qualification["rlib"]["path"])
    require(
        qualification["rlib"] == {"path": str(rlib), **fingerprint(rlib)},
        "Qualified rlib changed",
    )
    identity = PAIRS.source_identity(source, variant)
    originals = {
        path: (source / path).read_text()
        for path in MODIFIED - {"native/gpui-host/src/allocation.rs"}
    }
    patched = patch_sources(originals, ADAPTER.read_text())
    output.mkdir()
    diff = []
    for path, value in sorted(patched.items()):
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
        diff.extend(
            difflib.unified_diff(
                originals.get(path, "").splitlines(keepends=True),
                value.splitlines(keepends=True),
                fromfile=f"a/{path}" if path in originals else "/dev/null",
                tofile=f"b/{path}",
            )
        )
    (output / "native.patch").write_text("".join(diff))
    flags = compiler_flags(rlib)
    record = {
        "status": "source_patch_prepared",
        "original": identity,
        "qualification": qualification,
        "patch": fingerprint(output / "native.patch"),
        "files": [
            {"path": path, **fingerprint(output / path)} for path in sorted(patched)
        ],
        "hostFlags": flags,
        "requiredCommandsInSeparatePatchedCheckout": [
            [
                "cargo",
                "clippy",
                "--locked",
                "--release",
                "-p",
                "bun-native-host",
                "--bin",
                "bun-native-host",
                "--",
                "-Dwarnings",
                *flags,
            ],
            [
                "cargo",
                "rustc",
                "--locked",
                "--release",
                "-p",
                "bun-native-host",
                "--bin",
                "bun-native-host",
                "--",
                *flags,
            ],
        ],
        "scope": "Source patch only. No historical host compilation, workload execution or profiling occurred.",
    }
    require(
        PAIRS.source_identity(source, variant) == identity,
        "Historical original changed",
    )
    PAIRS.write_json(output / "patch-manifest.json", record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--variant", choices=tuple(PAIRS.VARIANTS), required=True)
    parser.add_argument("--qualification", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for path in (args.source, args.qualification, args.output):
        if not path.is_absolute():
            parser.error("All paths must be absolute")
    record = prepare_patch(
        args.source.resolve(),
        args.variant,
        PAIRS.read_json(args.qualification),
        args.output,
    )
    print(json.dumps({"status": record["status"], "output": str(args.output)}))


if __name__ == "__main__":
    main()
