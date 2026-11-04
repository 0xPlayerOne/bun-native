"""Bounded pipe capture and immutable process ownership for native watch evidence."""

import importlib.util
import json
import threading
import time
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "native_input_linux", Path(__file__).with_name("native-input-linux.py")
)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


def require_identity(table, identity):
    row = table.get(identity["pid"])
    if (
        row is None
        or row["start_ticks"] != identity["start_ticks"]
        or row["state"] == "Z"
    ):
        raise RuntimeError("Owned process identity changed or exited")
    return row


def require_absent(table, identities):
    for identity in identities:
        row = table.get(identity["pid"])
        if row is not None and row["start_ticks"] == identity["start_ticks"]:
            raise RuntimeError("A previous app or host is still live or unreaped")


class Ownership:
    """Discovery ends permanently when the originally launched root disappears."""

    def __init__(self, root):
        self.root = dict(root)
        self.observed = {root["pid"]: root["start_ticks"]}
        self.discovering = True

    def rows(self, table):
        root = table.get(self.root["pid"])
        if root is None or root["start_ticks"] != self.root["start_ticks"]:
            self.discovering = False
        if self.discovering:
            rows = DRIVER.owned_processes(self.root["pid"], table)
        else:
            # Never follow a recycled PID/PGID to new children after root exit.
            rows = [
                row
                for pid, started in self.observed.items()
                if (row := table.get(pid)) is not None and row["start_ticks"] == started
            ]
        # Validate the whole snapshot before adding even its first row. An
        # earlier-sorted new PID cannot become authorized by a rejected sample.
        if any(
            row["pid"] in self.observed
            and self.observed[row["pid"]] != row["start_ticks"]
            for row in rows
        ):
            raise RuntimeError("Owned PID was reused; preserve the earlier identity")
        for row in rows:
            self.observed.setdefault(row["pid"], row["start_ticks"])
        return sorted(rows, key=lambda row: row["pid"])


class Capture:
    """Drain a pipe with bounded logs and bounded, timestamped CLI records."""

    def __init__(self, stream, path, *, record_limit, parse=False):
        self.stream, self.path, self.parse = stream, path, parse
        self.record_limit = record_limit
        self.records = []
        self.written = 0
        self.discarded = 0
        self.error = None
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        pending = b""
        try:
            with self.path.open("xb") as output:
                while chunk := self.stream.read1(8192):
                    remaining = max(0, DRIVER.MAX_LOG_BYTES - self.written)
                    output.write(chunk[:remaining])
                    output.flush()
                    self.written += min(remaining, len(chunk))
                    self.discarded += max(0, len(chunk) - remaining)
                    if self.discarded:
                        self.error = "Watch process log exceeded its 4 MiB bound"
                    if not self.parse or self.error:
                        continue
                    pending += chunk
                    if len(pending) > DRIVER.PAINT_OBSERVER.MAX_RECORD_BYTES:
                        raise RuntimeError("Watch stdout record exceeded its bound")
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        for kind in ("ready", "stopped"):
                            prefix = f"bun-native:{kind} ".encode()
                            if not line.startswith(prefix):
                                continue
                            value = json.loads(
                                line[len(prefix) :],
                                object_pairs_hook=DRIVER.PAINT_OBSERVER.unique_object,
                                parse_constant=DRIVER.PAINT_OBSERVER.invalid_constant,
                                parse_float=DRIVER.PAINT_OBSERVER.finite_number,
                            )
                            with self.lock:
                                if len(self.records) >= self.record_limit:
                                    raise RuntimeError(
                                        "Watch emitted too many lifecycle records"
                                    )
                                self.records.append(
                                    {
                                        "kind": kind,
                                        "value": value,
                                        "observed_ns": time.monotonic_ns(),
                                    }
                                )
        except (OSError, ValueError, RuntimeError) as error:
            self.error = str(error)

    def snapshot(self):
        if self.error:
            raise RuntimeError(self.error)
        with self.lock:
            return list(self.records)


class ProcessAudit:
    """Retain immutable PID/start-tick ownership and sample remount overlap."""

    def __init__(self, app, host, bun):
        self.app, self.host, self.bun = app, str(host), str(bun)
        root = DRIVER.process_table().get(app.pid)
        if root is None:
            raise RuntimeError("Cannot anchor the launched watch process identity")
        self.ownership = Ownership({"pid": app.pid, "start_ticks": root["start_ticks"]})
        self.observed = self.ownership.observed
        self.images = {}
        self.controllers = None
        self.changes = []
        self.signature = None
        self.error = None
        self.max_hosts = 0
        self.max_apps = 0
        self.peak_rss = 0
        self.lock = threading.Lock()
        self.finished = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while not self.finished.is_set():
                table = DRIVER.process_table()
                with self.lock:
                    rows = self.ownership.rows(table)
                    if (
                        len(rows) > 128
                        or len(self.observed) > 512
                        or len(self.changes) > 2048
                    ):
                        raise RuntimeError("Watch process evidence exceeded its bound")
                    for row in rows:
                        pid = row["pid"]
                        try:
                            self.images[pid] = str(
                                Path(f"/proc/{pid}/exe").resolve(strict=True)
                            )
                        except FileNotFoundError:
                            continue
                    live = [row for row in rows if row["state"] != "Z"]
                    hosts = [
                        row["pid"]
                        for row in live
                        if self.images.get(row["pid"]) == self.host
                    ]
                    apps = [
                        row["pid"]
                        for row in live
                        if self.controllers is not None
                        and row["parent_pid"] in self.controllers
                        and row["pid"] not in self.controllers
                        and self.images.get(row["pid"]) == self.bun
                    ]
                    if len(hosts) > 1 or len(apps) > 1:
                        raise RuntimeError(
                            "Overlapping native hosts or application processes"
                        )
                    self.max_hosts = max(self.max_hosts, len(hosts))
                    self.max_apps = max(self.max_apps, len(apps))
                    self.peak_rss = max(
                        self.peak_rss, sum(row["rss_bytes"] for row in live)
                    )
                    signature = [
                        (row["pid"], row["start_ticks"], row["state"] == "Z")
                        for row in rows
                    ]
                    if signature != self.signature:
                        self.signature = signature
                        self.changes.append(
                            {
                                "observed_ns": time.monotonic_ns(),
                                "processes": rows,
                                "hosts": hosts,
                                "apps": apps,
                            }
                        )
                self.finished.wait(0.01)
        except (OSError, RuntimeError) as error:
            self.error = str(error)

    def bind_controllers(self, pid):
        table = DRIVER.process_table()
        require_identity(table, self.ownership.root)
        controllers = set()
        parent = table[pid]["parent_pid"]
        while parent not in controllers:
            controllers.add(parent)
            if parent == self.app.pid:
                break
            row = table.get(parent)
            if row is None or len(controllers) > 16:
                raise RuntimeError(
                    "Ready app does not descend from the launched watch command"
                )
            parent = row["parent_pid"]
        if self.app.pid not in controllers:
            raise RuntimeError("Watch controller ancestry is invalid")
        with self.lock:
            self.controllers = controllers

    def check(self):
        if self.error:
            raise RuntimeError(self.error)

    def snapshot(self):
        with self.lock:
            return dict(self.observed)

    def resource_snapshot(self, application, host):
        self.check()
        table = DRIVER.process_table()
        require_identity(table, self.ownership.root)
        require_identity(table, application)
        require_identity(table, host)
        with self.lock:
            rows = self.ownership.rows(table)
            controllers = set(self.controllers or ())
        return {
            "observed_ns": time.monotonic_ns(),
            "phase": "after complete counter-one native paint",
            "rss_scope": "Sum of owned process RSS; shared pages may be counted more than once",
            "tree_rss_bytes": sum(row["rss_bytes"] for row in rows),
            "processes": [
                {
                    **row,
                    "role": "application"
                    if row["pid"] == application["pid"]
                    else "native-host"
                    if row["pid"] == host["pid"]
                    else "cli-controller"
                    if row["pid"] in controllers
                    else "other-owned",
                }
                for row in rows
            ],
        }

    def identity(self, pid, executable, parent=None):
        self.check()
        table = DRIVER.process_table()
        row = table.get(pid)
        with self.lock:
            owned = {item["pid"] for item in self.ownership.rows(table)}
            if not self.ownership.discovering:
                raise RuntimeError(
                    "Watch process exited; no new window ownership may be claimed"
                )
        if (
            row is None
            or row["state"] == "Z"
            or pid not in owned
            or Path(f"/proc/{pid}/exe").resolve(strict=True) != executable
        ):
            raise RuntimeError("Ready process is not an owned executable")
        if parent is not None:
            require_identity(table, parent)
            children = {
                item["pid"] for item in DRIVER.owned_processes(parent["pid"], table)
            }
            if pid not in children or pid == parent["pid"]:
                raise RuntimeError("Window host does not belong to the ready app")
        return {"pid": pid, "start_ticks": row["start_ticks"]}
