"""One fixed Windows experiment. Failed original tests stay failed, never qualified."""

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

root = Path(os.environ["GITHUB_WORKSPACE"])
output = Path(os.environ["RUNNER_TEMP"]) / "pre-gc-stack-evidence"
output.mkdir()
source = root / "tests/solid/renderer.test.ts"
source_bytes = source.read_bytes()
plan = {
    "scope": "Research only; this job is not Validation / Gate",
    "source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "sourceTestSha256": hashlib.sha256(source_bytes).hexdigest(),
    "order": ["original", "dormant", "pre-collection"],
    "attemptsPerVariant": 1,
    "priorSetupOnlyFailure": 41765390777,
    "producerAndAssert": "Unchanged test module, full source suite, original two GC calls and zero-survivor assertion",
    "nativeCopy": "16 private 256-KiB snapshots maximum, no target pointer known before collection, no raw stack upload",
}
(output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
vswhere = (
    Path(os.environ["ProgramFiles(x86)"])
    / "Microsoft Visual Studio/Installer/vswhere.exe"
)
installation = subprocess.check_output(
    [
        str(vswhere),
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
    ],
    text=True,
).strip()
vcvars = Path(installation) / "VC/Auxiliary/Build/vcvars64.bat"
assert vcvars.is_file()
library = output / "capture.dll"
# A batch file avoids passing CMD syntax through Python's C-runtime argument
# quoting, which otherwise escapes the quotes in the vcvars path literally.
command = f'cl.exe /nologo /W4 /WX /O2 /LD "{root / "experiments/retention-checkpoints/capture.c"}" /link /OUT:"{library}"'
build_script = output / "compile-observer.cmd"
build_script.write_text(
    f'@echo off\ncall "{vcvars}" >nul\nif errorlevel 1 exit /b %errorlevel%\n'
    + command
    + "\nexit /b %errorlevel%\n",
    newline="\r\n",
)
with (output / "native-build.log").open("w") as log:
    built = subprocess.run(
        ["cmd.exe", "/d", "/c", str(build_script)],
        cwd=output,
        stdout=log,
        stderr=subprocess.STDOUT,
        timeout=90,
        check=False,
    )
if built.returncode != 0:
    print((output / "native-build.log").read_text(errors="replace"), flush=True)
assert built.returncode == 0, "Native observer compilation failed; inspect retained log"
(output / "native-identity.json").write_text(
    json.dumps(
        {
            "dllSha256": hashlib.sha256(library.read_bytes()).hexdigest(),
            "compilerCommand": command,
            "bunRevision": subprocess.check_output(
                ["bun", "--revision"], text=True
            ).strip(),
        },
        indent=2,
    )
    + "\n"
)
results = []
for variant in plan["order"]:
    directory = output / variant
    directory.mkdir()
    environment = dict(os.environ)
    environment["BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR"] = str(directory)
    environment["BUN_NATIVE_CHECKPOINT_OUTPUT_DIR"] = str(directory)
    environment["BUN_NATIVE_CHECKPOINT_LIBRARY"] = str(library)
    environment["BUN_NATIVE_CHECKPOINT_CAPTURE"] = (
        "1" if variant == "pre-collection" else "0"
    )
    arguments = ["bun", "test"]
    if variant != "original":
        arguments.extend(
            ["--preload", "./experiments/retention-checkpoints/preload.ts"]
        )
    arguments.append("tests")
    forced = False
    with (directory / "test.log").open("w") as log:
        process = subprocess.Popen(
            arguments, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT
        )
        try:
            code = process.wait(timeout=90)
        except subprocess.TimeoutExpired:
            forced = True
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
                check=False,
            )
            code = process.wait(timeout=10)
    text = (directory / "test.log").read_text(errors="replace")
    metadata = [
        json.loads(path.read_text())
        for path in directory.glob("solid-retention-*.json")
    ]
    observation = {
        "variant": variant,
        "exitCode": code,
        "forced": forced,
        "survivors": [
            [item["index"] for item in data["survivors"]] for data in metadata
        ],
        "failures": [
            line for line in text.splitlines() if re.search(r"\(fail\)", line)
        ],
        "nativeReportPresent": bool(list(directory.glob("pre-gc-stack-*.json"))),
    }
    results.append(observation)
    (output / "outcomes.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(observation), flush=True)
assert source.read_bytes() == source_bytes, "Producer source changed"
