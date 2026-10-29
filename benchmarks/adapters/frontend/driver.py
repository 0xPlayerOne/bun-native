"""Real browser HMR driver; environment failures are recorded, never relabeled passes.

Requires an installed Chromium and Playwright. Uses the browser process sandbox;
never changes browser policies. This is a bare-Bun fixture, not an Electron/CEF
adapter and not a desktop performance comparison.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
TEMPLATES = ROOT / "benchmarks/fixtures/frontend"


def compiler_diagnostic(lines: list[str]) -> str | None:
    """Require the actual parser rejection and source location, never an old log."""
    text = "\n".join(lines)
    if not re.search(r"(?:^|/)revision\.ts:\d+:\d+", text, re.MULTILINE):
        return None
    if not re.search(
        r"error:\s*(?:Unexpected\s+;|Expected\s+(?:expression|identifier)|SyntaxError|ParseError)",
        text,
    ):
        return None
    return "Bun rejected revision.ts with a fresh parser diagnostic"


class FixtureProcess:
    """Bounded NDJSON observation without selecting Windows pipe handles."""

    def __init__(self, command: list[str], cwd: Path):
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.events: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1024)
        self.error: str | None = None
        self.lines: list[str] = []
        self._diagnostics: deque[tuple[int, str]] = deque(maxlen=64)
        self._cursor = 0
        self._lock = threading.Lock()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        total = 0
        assert self.process.stdout is not None
        for line in iter(lambda: self.process.stdout.readline(65537), ""):
            total += len(line.encode("utf-8"))
            if total > 256 * 1024:
                self.error = "Fixture output budget exceeded"
                self.process.terminate()
                return
            self.lines.append(line.rstrip())
            self.lines = self.lines[-64:]
            with self._lock:
                self._cursor += 1
                self._diagnostics.append((self._cursor, line.rstrip()))
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    self.events.put_nowait(value)
            except json.JSONDecodeError:
                continue
            except queue.Full:
                self.error = "Fixture event budget exceeded"
                self.process.terminate()
                return

    def ready(self) -> dict[str, Any]:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.error:
                raise RuntimeError(self.error)
            try:
                event = self.events.get(timeout=0.05)
                if event.get("event") == "ready":
                    return event
            except queue.Empty:
                if self.process.poll() is not None:
                    raise RuntimeError(
                        "Fixture exited before readiness: " + "\n".join(self.lines)[-2048:]
                    ) from None
        raise RuntimeError("Fixture readiness deadline exceeded")

    def diagnostic_cursor(self) -> int:
        with self._lock:
            return self._cursor

    def wait_compile_error(self, after: int) -> str:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.error or self.process.poll() is not None:
                raise RuntimeError("Fixture failed while observing the invalid edit")
            with self._lock:
                fresh = [line for cursor, line in self._diagnostics if cursor > after]
            evidence = compiler_diagnostic(fresh)
            if evidence:
                return evidence
            time.sleep(0.01)
        raise RuntimeError("No fresh parser diagnostic for the invalid revision.ts edit")

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=4)
        self.reader.join(timeout=2)
        if self.reader.is_alive():
            raise RuntimeError("Fixture retained its output pipe")


def fixture_hash() -> str:
    digest = hashlib.sha256()
    for path in sorted(TEMPLATES.glob("*.txt")):
        digest.update(path.name.encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--chromium", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--warmups", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.trials <= 100 or not 0 <= args.warmups <= 20:
        parser.error("Invalid trial count")
    output = Path(args.output).resolve()
    report: dict[str, Any] = {
        "schema": 1,
        "adapter": "bare-bun-frontend-chromium",
        "runClass": "local-smoke",
        "fixtureSha256": fixture_hash(),
        "trials": [],
        "sandboxRequested": True,
        "browserVersion": None,
        "bunVersion": None,
        "limitations": [
            "Not a Bunly, CEF, Electron, Mirin or Butter result",
            "Driver-observed DOM latency, not physical input-to-photon latency",
        ],
    }
    try:
        from playwright.sync_api import sync_playwright

        report["playwrightVersion"] = importlib.metadata.version("playwright")
        parent = ROOT / ".bunly/frontend-fixtures"
        parent.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as playwright:
            # Do not silently accept Playwright's no-sandbox default.
            browser = playwright.chromium.launch(
                executable_path=str(Path(args.chromium).resolve()),
                headless=True,
                chromium_sandbox=True,
            )
            report["browserVersion"] = browser.version
            try:
                for warmup, count in [(True, args.warmups), (False, args.trials)]:
                    for trial in range(count):
                        directory = Path(tempfile.mkdtemp(prefix="project-", dir=parent))
                        process = None
                        errors: deque[str] = deque(maxlen=64)
                        context = browser.new_context()
                        row: dict[str, Any] = {
                            "trial": trial,
                            "warmup": warmup,
                            "status": "failed",
                            "observations": [],
                            "metrics": {},
                        }
                        report["trials"].append(row)
                        try:
                            for source in TEMPLATES.glob("*.txt"):
                                shutil.copyfile(
                                    source, directory / source.name.removesuffix(".txt")
                                )
                            (directory / "package.json").write_text(
                                '{"name":"bunly-frontend-fixture","private":true,"type":"module"}',
                                encoding="utf-8",
                            )
                            process = FixtureProcess(
                                [str(Path(args.bun).resolve()), str(directory / "server.ts")],
                                directory,
                            )
                            ready = process.ready()
                            report["bunVersion"] = ready["bun"]
                            page = context.new_page()
                            page.set_default_timeout(8000)
                            page.on(
                                "console",
                                lambda message, errors=errors: (
                                    errors.append(message.text[-2048:])
                                    if message.type == "error"
                                    else None
                                ),
                            )
                            page.on(
                                "pageerror",
                                lambda error, errors=errors: errors.append(str(error)[-2048:]),
                            )
                            page.goto(ready["origin"], wait_until="domcontentloaded")
                            page.wait_for_function(
                                "document.documentElement.dataset.revision === 'initial'"
                            )
                            page.locator("#retained").fill("persistent-input")
                            page.locator("#increment").click()

                            def observe(sequence, page=page, process=process, row=row):
                                value = page.evaluate("""() => ({revision: document.documentElement.dataset.revision,
                                  document: document.documentElement.dataset.document,
                                  generation: Number(document.documentElement.dataset.generation),
                                  retainedInput: document.querySelector('#retained').value,
                                  counter: Number(document.querySelector('#count').textContent)})""")
                                value.update(instance=str(process.process.pid), sequence=sequence)
                                row["observations"].append(value)
                                return value

                            before = observe(1)
                            start = time.monotonic()
                            (directory / "revision.ts").write_text(
                                "export const revision = 'edited';\n", encoding="utf-8"
                            )
                            page.wait_for_function(
                                "document.documentElement.dataset.revision === 'edited'"
                            )
                            row["metrics"]["frontendEditToDOMMs"] = (
                                time.monotonic() - start
                            ) * 1000
                            changed = observe(2)
                            if (
                                before["document"] != changed["document"]
                                or changed["retainedInput"] != "persistent-input"
                                or changed["counter"] != 1
                                or changed["generation"] <= before["generation"]
                            ):
                                raise RuntimeError(
                                    "Edit did not retain the existing document/state"
                                )
                            error_cursor = process.diagnostic_cursor()
                            (directory / "revision.ts").write_text(
                                "export const revision = ;\n", encoding="utf-8"
                            )
                            # Bun 1.4.4 prints parser failures without emitting bun:error.
                            # Keep the real invalid edit and require its fresh diagnostic.
                            row["compilerDiagnostic"] = process.wait_compile_error(error_cursor)
                            failed = observe(3)
                            if any(
                                failed[key] != changed[key]
                                for key in (
                                    "revision",
                                    "document",
                                    "generation",
                                    "counter",
                                    "retainedInput",
                                )
                            ):
                                raise RuntimeError("Broken source changed the last usable document")
                            row["diagnostic"] = {
                                "kind": "compile-error",
                                "sequence": 3,
                                "attemptedRevision": "broken",
                            }
                            start = time.monotonic()
                            (directory / "revision.ts").write_text(
                                "export const revision = 'repaired';\n", encoding="utf-8"
                            )
                            page.wait_for_function(
                                "document.documentElement.dataset.revision === 'repaired'"
                            )
                            row["metrics"]["repairToDOMMs"] = (time.monotonic() - start) * 1000
                            repaired = observe(4)
                            if (
                                repaired["document"] != before["document"]
                                or repaired["counter"] != 1
                                or repaired["retainedInput"] != "persistent-input"
                            ):
                                raise RuntimeError("Repair lost document/state")
                            page.locator("#increment").click()
                            if page.locator("#count").inner_text() != "2":
                                raise RuntimeError("HMR retained duplicate click listeners")
                            row["status"] = "passed"
                        except Exception as error:
                            row["error"] = str(error)[-8192:]
                            row["browserDiagnostics"] = list(errors)
                        finally:
                            context.close()
                            if process:
                                row["fixtureDiagnostics"] = [
                                    line.replace(str(directory), "<fixture>")
                                    for line in process.lines[-30:]
                                ]
                            try:
                                if process:
                                    process.close()
                            except Exception as error:
                                row["status"] = "failed"
                                row["cleanupError"] = str(error)
                            shutil.rmtree(directory)
                        # An environment denial is decisive; do not keep retrying
                        # the same denied browser action to fill the trial plan.
                        if row["status"] != "passed":
                            raise RuntimeError(
                                "Frontend qualification failed; remaining planned trials not executed"
                            )
            finally:
                browser.close()
    except Exception as error:
        report["failure"] = str(error)[-8192:]
    expected = args.trials + args.warmups
    report["plan"] = {
        "repetitions": args.trials,
        "warmups": args.warmups,
        "expectedExecutions": expected,
    }
    report["passed"] = (
        "failure" not in report
        and len(report["trials"]) == expected
        and all(row["status"] == "passed" for row in report["trials"])
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {"passed": report["passed"], "executed": len(report["trials"]), "output": str(output)}
        )
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
