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


def notify_tree_observation(port, nonce, pids):
    """One bounded numeric-loopback publication after independent ancestry observation."""
    if (
        type(port) is not int
        or not 0 < port <= 65535
        or not isinstance(nonce, str)
        or not re.fullmatch(r"[a-f0-9]{48}", nonce)
        or not isinstance(pids, list)
        or len(pids) != 2
        or any(type(pid) is not int or not 0 < pid < 2**31 for pid in pids)
        or len(set(pids)) != 2
    ):
        raise ValueError("Invalid tree notification identity")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        connection.request(
            "POST",
            "/observed",
            body=json.dumps({"mode": "backend-shell-tree-exit", "nonce": nonce, "pids": pids}),
            headers={"x-bunly-observation": nonce, "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        if response.status != 204 or response.read(1):
            raise ValueError("Invalid tree notification acknowledgment")
    finally:
        connection.close()
