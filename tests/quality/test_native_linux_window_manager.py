"""Headless model of Xvfb regeneration during the session's window manager start.

Xvfb started by xvfb-run regenerates when its last fully connected client
leaves, and regeneration closes every client still in connection setup. The
fake xprop and openbox below share a small file-based connection table with
those semantics, so these controls run no X server, window manager or GUI.
"""

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/quality/native-linux-window-manager.sh"

FAKE_X = textwrap.dedent(
    """
    import fcntl, os, signal, sys, time
    from pathlib import Path

    state = Path(os.environ["FAKE_X_STATE"])
    clients = state / "clients"
    clients.mkdir(exist_ok=True)
    me = clients / str(os.getpid())
    # A client killed mid-setup just vanishes; one killed while connected
    # disconnects. Neither path may block on the lock inside the handler.
    stop = []
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))

    def locked(action):
        with open(state / "lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return action()

    def event(text):
        with open(state / "events", "a") as log:
            log.write(text + "\\n")

    def connect(setup_seconds, name):
        locked(lambda: me.with_suffix(".setup").touch())
        deadline = time.monotonic() + setup_seconds
        while time.monotonic() < deadline:
            if stop:
                locked(lambda: me.with_suffix(".setup").unlink(missing_ok=True))
                sys.exit(0)
            if not me.with_suffix(".setup").exists():
                event(f"{name} closed during connection setup")
                print(f"{name}: Failed to open the display", file=sys.stderr)
                sys.exit(1)
            time.sleep(0.01)

        def promote():
            if not me.with_suffix(".setup").exists():
                return False
            me.with_suffix(".setup").rename(me.with_suffix(".running"))
            return True

        if not locked(promote):
            event(f"{name} closed during connection setup")
            print(f"{name}: Failed to open the display", file=sys.stderr)
            sys.exit(1)

    def disconnect():
        def leave():
            me.with_suffix(".running").unlink(missing_ok=True)
            if not any(clients.glob("*.running")):
                for pending in clients.glob("*.setup"):
                    pending.unlink()
                event("server regenerated")

        locked(leave)

    def until_terminated(tick=None):
        while not stop:
            if tick:
                tick()
            time.sleep(0.02)
        disconnect()

    name, args = sys.argv[1], sys.argv[2:]
    ready = state / "wm-ready"
    wm_line = "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x200001"
    if name == "openbox":
        if os.environ.get("FAKE_OPENBOX_EXIT"):
            sys.exit(1)
        # A wide setup window, so loaded runners still see probes finish inside
        # it; still well within the session's five second readiness budget.
        connect(1.5, name)
        ready.touch()
        until_terminated()
    elif args[:2] == ["-root", "-spy"]:
        connect(0.05, name)
        printed = []

        def report():
            if ready.exists() and not printed:
                print(wm_line, flush=True)
                printed.append(1)

        until_terminated(report)
    else:
        connect(0.01, name)
        print(wm_line if ready.exists() else "_NET_SUPPORTING_WM_CHECK:  not found.")
        event("short probe while window manager " + ("ready" if ready.exists() else "connecting"))
        disconnect()
    """
)

# The session script's readiness loop before the probe held a connection.
PREVIOUS_POLLING = textwrap.dedent(
    """
    openbox >"$1/window-manager.log" 2>&1 &
    window_manager=$!
    trap 'kill $window_manager 2>/dev/null; wait $window_manager 2>/dev/null' EXIT
    for attempt in {1..50}; do
      if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
        break
      fi
      if ! kill -0 "$window_manager" 2>/dev/null; then
        echo 'The test window manager exited before becoming ready' >&2
        exit 1
      fi
      sleep 0.1
    done
    xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id'
    """
)

CURRENT = textwrap.dedent(
    """
    source "$2"
    trap stop_test_window_manager EXIT
    start_test_window_manager "$1"
    """
)


class WindowManagerStartTests(unittest.TestCase):
    def run_session(self, script, **env):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            (root / "fake_x.py").write_text(FAKE_X)
            for name in ("xprop", "openbox"):
                fake = bin_dir / name
                fake.write_text(
                    f'#!/bin/sh\nexec "{sys.executable}" -S "{root / "fake_x.py"}" {name} "$@"\n'
                )
                fake.chmod(0o755)
            evidence = root / "evidence"
            evidence.mkdir()
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    "set -euo pipefail\n" + script,
                    "session",
                    str(evidence),
                    str(HELPER),
                ],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                    "FAKE_X_STATE": str(root),
                    **env,
                },
                capture_output=True,
                check=False,
                text=True,
                timeout=30,
            )
            events_file = root / "events"
            events = (
                events_file.read_text().splitlines() if events_file.exists() else []
            )
            leftover = (
                sorted(path.name for path in (root / "clients").glob("*"))
                if (root / "clients").exists()
                else []
            )
            return result, events, leftover

    def test_model_reproduces_the_ci_failure_with_short_readiness_probes(self):
        result, events, _ = self.run_session(PREVIOUS_POLLING)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(
            "The test window manager exited before becoming ready", result.stderr
        )
        self.assertLess(
            events.index("server regenerated"),
            events.index("openbox closed during connection setup"),
        )

    def test_held_probe_keeps_the_server_from_regenerating_during_start(self):
        result, events, leftover = self.run_session(CURRENT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("openbox closed during connection setup", events)
        self.assertNotIn("short probe while window manager connecting", events)
        self.assertIn("short probe while window manager ready", events)
        # Teardown stops the probe and openbox; only then may the server regenerate.
        self.assertEqual(events[-1], "server regenerated")
        self.assertEqual(leftover, [])

    def test_window_manager_exit_before_ready_still_fails_the_session(self):
        result, _events, leftover = self.run_session(CURRENT, FAKE_OPENBOX_EXIT="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "The test window manager exited before becoming ready", result.stderr
        )
        self.assertEqual(leftover, [])


if __name__ == "__main__":
    unittest.main()
