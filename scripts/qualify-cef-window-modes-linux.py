"""Disposable-runner X11/WM owner; never attaches to or changes a desktop session."""

import argparse
import json
import os
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def ready(fd: int, expected: bytes | None = None) -> bytes:
    # Event readiness, once, with a finite deadline. No polling/retry-to-green.
    if not select.select([fd], [], [], 10)[0]:
        raise RuntimeError("Disposable X11/WM readiness deadline")
    value = os.read(fd, 64)
    if expected is not None and value != expected:
        raise RuntimeError("Invalid disposable WM readiness receipt")
    return value


def stop(child: subprocess.Popen) -> None:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        return
    raise RuntimeError("Disposable display process group survived cleanup")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-runner", action="store_true", required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() == 0:
        raise RuntimeError("Use a standard user on a disposable Linux runner")
    for tool in ("Xvfb", "openbox"):
        if not shutil.which(tool):
            raise RuntimeError(f"Runner prerequisite missing: {tool}; mode is NOT_QUALIFIED")
    parent = ROOT / ".bunly/m5/window-modes-linux"
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    children = []
    report = {"passed": False, "processes": [], "cleanup": False}
    read_fd, write_fd = os.pipe()
    fifo_fd = None
    try:
        with (work / "xvfb.log").open("wb") as log:
            display = subprocess.Popen(
                [
                    "Xvfb",
                    "-displayfd",
                    str(write_fd),
                    "-screen",
                    "0",
                    "1280x800x24",
                    "-nolisten",
                    "tcp",
                ],
                pass_fds=(write_fd,),
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        children.append(display)
        report["processes"].append({"role": "Xvfb", "pid": display.pid})
        os.close(write_fd)
        write_fd = -1
        display_number = ready(read_fd).strip()
        if not display_number.isdigit():
            raise RuntimeError("Invalid Xvfb display receipt")
        env = {**os.environ, "DISPLAY": ":" + display_number.decode("ascii")}
        config = work / "openbox.xml"
        config.write_text(
            '<openbox_config xmlns="http://openbox.org/3.4/rc"><desktops><number>1</number></desktops></openbox_config>\n'
        )
        fifo = work / "ready"
        os.mkfifo(fifo, 0o600)
        fifo_fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        with (work / "openbox.log").open("wb") as log:
            wm = subprocess.Popen(
                [
                    "openbox",
                    "--sm-disable",
                    "--config-file",
                    str(config),
                    "--startup",
                    shlex.join(["/bin/sh", "-c", "printf ready > " + shlex.quote(str(fifo))]),
                ],
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        children.append(wm)
        report["processes"].append({"role": "openbox", "pid": wm.pid})
        ready(fifo_fd, b"ready")
        # The maintained qualifier owns native command timeout and descendant cleanup.
        result = subprocess.run(
            [
                str(args.bun.resolve(strict=True)),
                str(ROOT / "scripts/qualify-cef-window-modes.ts"),
                str(args.app.resolve(strict=True)),
            ],
            env=env,
            cwd=ROOT,
            check=False,
        )
        report["exitCode"] = result.returncode
        report["passed"] = result.returncode == 0
    except Exception as error:
        report["failure"] = str(error)
    finally:
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)
        if fifo_fd is not None:
            os.close(fifo_fd)
        failures = []
        for child in reversed(children):
            try:
                stop(child)
            except Exception as error:
                failures.append(str(error))
        report["cleanup"] = not failures
        if failures:
            report["passed"] = False
            report["cleanupFailures"] = failures
        (work / "runner.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"report": str(work / "runner.json"), "passed": report["passed"]}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
