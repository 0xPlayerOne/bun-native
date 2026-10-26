"""An independently owned same-executable negative control for native cleanup tests."""

import http.client
import json
import re
import subprocess
import threading

import psutil


class ForeignControl:
    """Only this Popen handle is ever stopped; no process-name or guessed-PID lookup."""

    def __init__(self, executable):
        self.process = subprocess.Popen(
            [
                str(executable),
                "-e",
                "console.log(JSON.stringify({pid:process.pid})); await Bun.stdin.text();",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.reader = None
        self.receipt = {"ready": False, "aliveAfterHostExit": False, "releasedNormally": False}
        try:
            ready = threading.Event()
            lines = []

            def read():
                lines.append(self.process.stdout.readline(128))
                ready.set()

            self.reader = threading.Thread(target=read, daemon=True)
            self.reader.start()
            if not ready.wait(5) or len(lines) != 1:
                raise ValueError("Foreign process control did not become ready")
            row = json.loads(lines[0])
            if row != {"pid": self.process.pid}:
                raise ValueError("Foreign process control has wrong identity")
            self.reader.join(timeout=5)
            self.receipt.update(
                ready=True,
                pid=self.process.pid,
                creationTime=psutil.Process(self.process.pid).create_time(),
                sameExecutableAsBackend=True,
            )
        except BaseException:
            self.finish(observe=False)
            raise

    def finish(self, *, observe=True):
        try:
            if observe:
                self.receipt["aliveAfterHostExit"] = (
                    self.process.poll() is None
                    and psutil.Process(self.process.pid).create_time()
                    == self.receipt["creationTime"]
                )
            if self.process.stdin and not self.process.stdin.closed:
                self.process.stdin.close()
            self.receipt["releasedNormally"] = self.process.wait(timeout=5) == 0
        except (OSError, psutil.Error, subprocess.TimeoutExpired):
            self.receipt["releasedNormally"] = False
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=5)
            if self.reader is not None:
                self.reader.join(timeout=5)
            for stream in (self.process.stdin, self.process.stdout):
                if stream is not None and not stream.closed:
                    stream.close()
        return dict(self.receipt)


def accept_foreign_control(control, observation):
    if not isinstance(control, dict) or set(control) != {
        "pid",
        "creationTime",
        "ready",
        "aliveAfterHostExit",
        "releasedNormally",
        "sameExecutableAsBackend",
    }:
        raise ValueError("Missing or malformed independent process control")
    if (
        type(control["pid"]) is not int
        or not 0 < control["pid"] < 2**31
        or type(control["creationTime"]) not in (int, float)
        or not 0 < control["creationTime"] < float("inf")
        or any(
            control[field] is not True
            for field in (
                "ready",
                "aliveAfterHostExit",
                "releasedNormally",
                "sameExecutableAsBackend",
            )
        )
    ):
        raise ValueError("Independent process was not preserved and normally released")
    if any(
        row.get("pid") == control["pid"]
        for sample in observation.get("samples", [])
        for row in sample.get("processes", [])
    ):
        raise ValueError("Foreign control was part of the native owned process tree")


def notify_tree_observation(port, nonce, pids, *, mode="backend-shell-tree-exit"):
    """One bounded numeric-loopback publication after independent ancestry observation."""
    if (
        mode not in ("backend-tree-exit", "backend-shell-tree-exit")
        or type(port) is not int
        or not 0 < port <= 65535
        or not isinstance(nonce, str)
        or not re.fullmatch(r"[a-f0-9]{48}", nonce)
        or not isinstance(pids, list)
        or len(pids) != (1 if mode == "backend-tree-exit" else 2)
        or any(type(pid) is not int or not 0 < pid < 2**31 for pid in pids)
        or len(set(pids)) != len(pids)
    ):
        raise ValueError("Invalid tree notification identity")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        connection.request(
            "POST",
            "/observed",
            body=json.dumps({"mode": mode, "nonce": nonce, "pids": pids}),
            headers={"x-bunly-observation": nonce, "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        if response.status != 204 or response.read(1):
            raise ValueError("Invalid tree notification acknowledgment")
    finally:
        connection.close()


def fault_readiness(path, nonce, mode):
    """Read one bounded private marker; renderer injection requires native frame proof."""
    try:
        if (
            mode not in ("renderer-exit", "gpu-exit")
            or path.is_symlink()
            or path.stat().st_size > 4096
        ):
            return None

        def exact_object(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("Duplicate fault readiness field")
                value[key] = item
            return value

        with path.open("rb") as source:
            encoded = source.read(4097)
        if len(encoded) > 4096:
            return None
        value = json.loads(encoded, object_pairs_hook=exact_object)
        fields = {"mode", "nonce", "pid"}
        if mode == "renderer-exit":
            fields.add("rendererPid")
        if (
            not isinstance(value, dict)
            or set(value) != fields
            or value["nonce"] != nonce
            or value["mode"] != mode
        ):
            return None
        if type(value["pid"]) is not int or not 0 < value["pid"] < 2**31:
            return None
        if mode == "renderer-exit" and (
            type(value["rendererPid"]) is not int
            or not 0 < value["rendererPid"] < 2**31
            or value["rendererPid"] == value["pid"]
        ):
            return None
        return value
    except (OSError, ValueError, TypeError):
        return None


def fault_target_matches(readiness, mode, pid):
    """A role match alone cannot select a renderer that is not the fault page's host."""
    return (
        isinstance(readiness, dict)
        and bool(readiness)
        and (mode == "gpu-exit" or mode == "renderer-exit" and readiness["rendererPid"] == pid)
    )
