"""Exercise real disk exhaustion on a private 64 MiB image, never the user's main filesystem."""

import argparse
import json
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args, timeout=60):
    result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(
            f"{Path(args[0]).name} failed ({result.returncode}): "
            + result.stderr.decode(errors="replace")[-2000:]
        )
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Disposable-volume execution currently requires macOS hdiutil")
    parent = ROOT / ".bunly/m3/storage"
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    mount = work / "volume"
    mount.mkdir(mode=0o700)
    image = work / "bounded.sparseimage"
    report = {
        "schema": 1,
        "passed": False,
        "profile": "native-disposable-volume-storage-qualification",
        "volumeDetached": False,
        "sourceCommit": run(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).decode().strip(),
        "sourceClean": not run(["git", "-C", str(ROOT), "status", "--porcelain"]).strip(),
    }
    try:
        run(
            [
                "/usr/bin/hdiutil",
                "create",
                "-size",
                "64m",
                "-fs",
                "HFS+",
                "-volname",
                "BunlyStorageFixture",
                "-type",
                "SPARSE",
                str(image),
            ]
        )
        response = plistlib.loads(
            run(
                [
                    "/usr/bin/hdiutil",
                    "attach",
                    "-plist",
                    "-nobrowse",
                    "-mountpoint",
                    str(mount),
                    str(image),
                ]
            )
        )
        matches = [
            entry
            for entry in response.get("system-entities", [])
            if entry.get("mount-point") == str(mount)
        ]
        if (
            len(matches) != 1
            or not mount.is_mount()
            or os.stat(mount).st_dev == os.stat(work).st_dev
        ):
            raise RuntimeError("Disposable volume identity could not be established")
        data = run(
            [
                str(Path(args.bun).resolve(strict=True)),
                str(ROOT / "scripts/qualify-cef-storage.ts"),
                str(work),
                str(mount),
            ],
            timeout=90,
        )
        report["execution"] = json.loads(data)
        if report["execution"].get("passed") is not True:
            raise RuntimeError("Storage worker failed acceptance")
        report["passed"] = True
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        report["failure"] = str(error)[-4000:]
    finally:
        try:
            if mount.is_mount():
                run(["/usr/bin/hdiutil", "detach", str(mount)], timeout=30)
            report["volumeDetached"] = not mount.is_mount()
            if not report["volumeDetached"]:
                report["passed"] = False
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            report["passed"] = False
            report["cleanupError"] = str(error)[-2000:]
        (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "passed": report["passed"],
                    "output": str(work / "report.json"),
                    "failure": report.get("failure"),
                    "volumeDetached": report["volumeDetached"],
                }
            )
        )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
