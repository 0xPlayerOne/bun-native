"""Headless driver safety tests. These do not verify a native window or input."""

import copy
import importlib.util
import io
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/quality/native-input-linux.py"
SPEC = importlib.util.spec_from_file_location("native_input_linux", SCRIPT)
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        if hasattr(signal, "SIGALRM"):
            self.previous_alarm_handler = signal.signal(
                signal.SIGALRM, self.deadline_exceeded
            )
            signal.alarm(10)

    def tearDown(self):
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            signal.signal(signal.SIGALRM, self.previous_alarm_handler)

    @staticmethod
    def deadline_exceeded(_signal, _frame):
        raise TimeoutError("A native harness safety test exceeded its 10-second limit")

    def test_only_new_records_with_matching_nonce_are_eligible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            old = json.dumps({"nonce": "run", "type": "input", "value": "old"}) + "\n"
            new = json.dumps({"nonce": "run", "type": "input", "value": "new"}) + "\n"
            path.write_text(old + new)
            events = DRIVER.read_events(path, "run", len(old.encode()))
            self.assertEqual([event["value"] for event in events], ["new"])
            self.assertTrue(
                DRIVER.matches(events[0], {"type": "input", "value": "new"})
            )
            self.assertFalse(DRIVER.matches(events[0], {}))
            self.assertFalse(DRIVER.matches(events[0], {"value": "old"}))
            with self.assertRaisesRegex(RuntimeError, "session nonce"):
                DRIVER.read_events(path, "other-run", 0)

    def test_partial_event_is_not_accepted_until_newline(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text('{"nonce":"run","type":"rendered"}')
            self.assertEqual(DRIVER.read_events(path, "run", 0), [])
            with path.open("a") as output:
                output.write("\n")
            self.assertEqual(len(DRIVER.read_events(path, "run", 0)), 1)

    def test_paint_requires_native_stage_full_tree_and_matching_revisions(self):
        expected = {
            "type": "rendered",
            "window_id": 1,
            "tree_revision": 2,
            "nodes": [
                {
                    "node_id": 1,
                    "element": {"kind": "box", "style": {}},
                    "children": [2],
                },
                {
                    "node_id": 2,
                    "element": {
                        "kind": "input",
                        "value": "native edit",
                        "placeholder": "",
                        "style": {},
                    },
                    "children": [],
                    "input_revision": 11,
                },
            ],
        }
        painted = {"stage": "native-paint", "nonce": "run", **expected}
        self.assertTrue(DRIVER.matches_paint(painted, expected))
        for change in [
            {"type": "ack"},
            {"stage": "bun-application"},
            {"window_id": 2},
            {"tree_revision": 1},
            {"nodes": expected["nodes"][:1]},
            {"status": "omitted", "reason": "evidence_record_limit"},
        ]:
            with self.subTest(change=change):
                self.assertFalse(DRIVER.matches_paint({**painted, **change}, expected))
        stale = copy.deepcopy(painted)
        stale["nodes"][1]["input_revision"] = 10
        self.assertFalse(DRIVER.matches_paint(stale, expected))
        stale["nodes"][1]["input_revision"] = 11
        stale["nodes"][1]["element"]["value"] = "stale application echo"
        self.assertFalse(DRIVER.matches_paint(stale, expected))

    def test_keyboard_activation_requires_a_distinct_callback_count(self):
        click = {
            "type": "click",
            "stage": "bun-application",
            "target": "increment",
            "activation": 1,
            "sequence": 3,
        }
        keyboard = {**click, "activation": 2, "sequence": 7}
        self.assertTrue(DRIVER.matches(click, DRIVER.fixture_click(1)))
        self.assertFalse(
            DRIVER.matches({**click, "activation": True}, DRIVER.fixture_click(1))
        )
        self.assertFalse(DRIVER.matches(click, DRIVER.fixture_click(2)))
        self.assertTrue(DRIVER.matches(keyboard, DRIVER.fixture_click(2)))

    def test_lifecycle_launch_survives_prior_native_focus_and_pointer_events(self):
        # This is the actual launch payload from failed hosted run 41236220063.
        # The lifecycle completed, but an obsolete sequence=1 oracle never closed
        # the window because protocol4's launch click had global sequence3.
        click = {
            "type": "click",
            "stage": "bun-application",
            "target": "public-lifecycle",
            "sequence": 3,
        }
        expected = DRIVER.lifecycle_fixture_event()
        self.assertTrue(DRIVER.matches(click, expected))
        self.assertFalse(DRIVER.matches(click, {**expected, "sequence": 1}))
        for change in (
            {"type": "focus"},
            {"stage": "native-paint"},
            {"target": "transient-button"},
        ):
            with self.subTest(change=change):
                self.assertFalse(DRIVER.matches({**click, **change}, expected))

    def test_event_stress_is_explicit_fixed_and_does_not_relax_smoke_limits(self):
        DRIVER.validate_input_request(
            False, "ordinary", "x" * 200, ["Return"] * 16, None
        )
        for text, keys in [
            ("x" * 201, []),
            (DRIVER.EVENT_STRESS_TEXT, []),
            ("x" * 180 + "{nonce}", []),
            (None, ["Return"] * 17),
        ]:
            with (
                self.subTest(text_length=len(text or ""), keys=len(keys)),
                self.assertRaisesRegex(ValueError, "Native smoke input"),
            ):
                DRIVER.validate_input_request(False, "ordinary", text, keys, None)
        valid = {
            "event_stress": True,
            "title": DRIVER.EVENT_STRESS_TITLE,
            "text": DRIVER.EVENT_STRESS_TEXT,
            "keys": [],
            "click": None,
        }
        DRIVER.validate_input_request(**valid)
        for changed in [
            {"title": "another window"},
            {"text": "x" * 999},
            {"text": "x" * 1001},
            {"text": "y" * 1000},
            {"keys": ["Return"]},
            {"click": [0, 0]},
        ]:
            with (
                self.subTest(changed=changed),
                self.assertRaisesRegex(ValueError, "Event stress requires"),
            ):
                DRIVER.validate_input_request(**{**valid, **changed})

    def test_event_stress_checks_every_edit_and_rejects_gaps_duplicates_and_bad_times(
        self,
    ):
        events = [
            {
                "type": "input",
                "stage": "bun-application",
                "sequence": index,
                "input_revision": index,
                "value": "x" * index,
                "observed_at_ms": 20 + index / 2,
            }
            for index in range(1, 1001)
        ]
        result = DRIVER.event_stress_observations(events, require_complete=True)
        self.assertTrue(result["complete"])
        self.assertEqual(result["verified_callbacks"], 1000)
        self.assertEqual(result["observed_callbacks_per_second"], 2000)
        # Keyboard/focus events share native global order but are not input
        # callbacks. Gaps are valid; duplicate or decreasing input order is not.
        with_other_events = [
            {**event, "sequence": event["sequence"] * 3} for event in events
        ]
        self.assertTrue(
            DRIVER.event_stress_observations(with_other_events, require_complete=True)[
                "complete"
            ]
        )
        partial = DRIVER.event_stress_observations(events[:-1])
        self.assertFalse(partial["complete"])
        with self.assertRaisesRegex(RuntimeError, "all 1000"):
            DRIVER.event_stress_observations(events[:-1], require_complete=True)
        with self.assertRaisesRegex(RuntimeError, "more than 1000"):
            DRIVER.event_stress_observations([*events, events[-1]])
        for changed in [
            {"sequence": 501},
            {"sequence": True},
            {"sequence": 0},
            {"sequence": 9_007_199_254_740_992},
            {"input_revision": 499},
            {"value": "x" * 499 + "y"},
            {"observed_at_ms": 0},
            {"observed_at_ms": float("nan")},
            {"observed_at_ms": True},
        ]:
            with self.subTest(changed=changed):
                damaged = [dict(event) for event in events]
                damaged[499].update(changed)
                with self.assertRaises(RuntimeError):
                    DRIVER.event_stress_observations(damaged, require_complete=True)

    def test_evidence_size_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            with path.open("wb") as output:
                output.truncate(DRIVER.MAX_LOG_BYTES + 1)
            with self.assertRaisesRegex(RuntimeError, "4 MiB"):
                DRIVER.read_events(path, "run", 0)

    def test_native_pointer_mode_requires_changed_complete_paint_and_no_callback_probe(
        self,
    ):
        initial = {
            "type": "rendered",
            "window_id": 1,
            "tree_revision": 1,
            "nodes": [{"node_id": 1, "element": {"kind": "text", "text": "Clicks: 0"}}],
        }
        final = {
            **initial,
            "tree_revision": 2,
            "nodes": [{"node_id": 1, "element": {"kind": "text", "text": "Clicks: 1"}}],
        }
        valid = {
            "click": [100, 130],
            "keys": [],
            "text": None,
            "expectations": [],
            "initial": initial,
            "final": final,
        }
        DRIVER.validate_native_pointer_request(**valid)
        for change in [
            {"click": None},
            {"keys": ["Return"]},
            {"text": "text"},
            {"expectations": [{"type": "click", "stage": "bun-application"}]},
            {"initial": None},
            {"initial": {**initial, "nodes": []}},
            {"final": {**final, "nodes": initial["nodes"]}},
            {"final": {**final, "window_id": True}},
            {"final": {**final, "window_id": 2}},
            {"final": {**final, "tree_revision": 1}},
            {"final": {**final, "tree_revision": True}},
        ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                DRIVER.validate_native_pointer_request(**{**valid, **change})

    def test_native_pointer_requires_ordered_native_down_up_at_the_injected_point(self):
        down = {
            "type": "pointer_trace",
            "stage": "gpui-window-input",
            "window_id": 1,
            "event": "down",
            "position": [100.0, 130.0],
            "button": "Left",
            "window_active": True,
            "trace_index": 3,
            "limit_reached": False,
        }
        up = {**down, "event": "up", "trace_index": 4}
        self.assertTrue(DRIVER.native_pointer_click_observed([down, up], 1, [100, 130]))
        # GPUI capture is not an application callback acknowledgement.
        self.assertFalse(
            DRIVER.matches(up, {"type": "click", "stage": "bun-application"})
        )
        for events in [[], [down], [up], [up, down]]:
            self.assertFalse(
                DRIVER.native_pointer_click_observed(events, 1, [100, 130])
            )
        for change in [
            {"type": "click"},
            {"stage": "bun-application"},
            {"position": [101, 130]},
            {"window_id": True},
            {"button": "Right"},
            {"trace_index": 3},
            {"trace_index": True},
            {"trace_index": 64},
            {"window_active": False},
            {"limit_reached": True},
        ]:
            with self.subTest(change=change):
                self.assertFalse(
                    DRIVER.native_pointer_click_observed(
                        [down, {**up, **change}], 1, [100, 130]
                    )
                )

    def test_native_pointer_accepts_preserved_xinput_quantization_in_same_pixel(self):
        evidence = json.loads(
            (
                Path(__file__).resolve().parents[1]
                / "native/evidence/template-pointer-x11-quantization.json"
            ).read_text()
        )
        down, up = evidence["raw_pointer_records"]
        expected = evidence["expected_position"]
        self.assertEqual(down["position"], [100.00152587890625, 130.00198364257812])
        self.assertTrue(DRIVER.native_pointer_click_observed([down, up], 1, expected))
        for position in (
            [99.5, 130],
            [100.5, 130],
            [100, 129.5],
            [100, 130.5],
            [101.00152587890625, 130.00198364257812],
            [100, 131],
            [float("nan"), 130],
            [100, float("inf")],
            [100, -float("inf")],
            [True, 130],
            [100, False],
            ["100", 130],
            [100],
            [100, 130, 0],
            None,
        ):
            with self.subTest(position=position):
                self.assertFalse(
                    DRIVER.native_pointer_click_observed(
                        [down, {**up, "position": position}], 1, expected
                    )
                )
        for events in (
            [up, down],
            [down, {**up, "trace_index": 3}],
            [down, {**up, "window_id": 2}],
        ):
            with self.subTest(events=events):
                self.assertFalse(
                    DRIVER.native_pointer_click_observed(events, 1, expected)
                )
        # Boolean coordinates must also fail when their numeric value would
        # otherwise be the requested zero/one pixel.
        for position in ([True, 0], [1, False]):
            records = [{**event, "position": position} for event in (down, up)]
            self.assertFalse(DRIVER.native_pointer_click_observed(records, 1, [1, 0]))
        for request in ([True, 130], [100, False], [100.0, 130], [100], None):
            with self.subTest(request=request):
                self.assertFalse(
                    DRIVER.native_pointer_click_observed([down, up], 1, request)
                )

    def test_output_is_drained_but_disk_capture_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stdout.log"
            stream = io.BytesIO(b"x" * (DRIVER.MAX_LOG_BYTES + 128))
            stats = {"written_bytes": 0, "discarded_bytes": 0}
            DRIVER.capture(stream, path, stats)
            self.assertEqual(path.stat().st_size, DRIVER.MAX_LOG_BYTES)
            self.assertEqual(stats["discarded_bytes"], 128)
            self.assertEqual(stream.read(), b"")

    def test_missing_display_never_launches_app_or_claims_aot(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence"
            marker = Path(directory) / "must-not-exist"
            environment = dict(os.environ)
            environment.pop("DISPLAY", None)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--output",
                    str(output),
                    "--mode",
                    "aot",
                    "--key",
                    "space",
                    "--",
                    sys.executable,
                    "-c",
                    "from pathlib import Path; import sys; Path(sys.argv[1]).touch()",
                    str(marker),
                ],
                check=False,
                env=environment,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(marker.exists())
            report = json.loads((output / "result.json").read_text())
            self.assertEqual(report["status"], "unsupported")
            self.assertFalse(report["execution_mode"]["aot_verified_by_driver"])
            self.assertEqual(report["checks"]["window"], "not-run")
            self.assertEqual(report["checks"]["app_input_event"], "unsupported")

    @unittest.skipUnless(
        sys.platform == "linux" and DRIVER.proc_identity_matches(),
        "Linux process IDs and /proc must share a PID namespace",
    )
    def test_real_process_tree_is_observed_and_stopped_without_killing_the_test(self):
        DRIVER.enable_subreaper()
        app = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import subprocess,sys,time\n"
                    'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"])\n'
                    "print(child.pid,flush=True)\n"
                    "time.sleep(30)"
                ),
            ],
            stdout=subprocess.PIPE,
            start_new_session=True,
        )
        try:
            ready, _, _ = select.select([app.stdout], [], [], 3)
            self.assertTrue(ready, "Child PID was not reported")
            child = int(app.stdout.readline())
            rows = DRIVER.owned_processes(app.pid, DRIVER.process_table())
            pids = {row["pid"] for row in rows}
            self.assertIn(app.pid, pids)
            self.assertIn(child, pids)
            self.assertNotIn(os.getpid(), pids)
            self.assertGreater(sum(row["rss_bytes"] for row in rows), 0)
            observed = {row["pid"]: row["start_ticks"] for row in rows}
            result = DRIVER.cleanup(app, observed)
            self.assertTrue(result["forced_termination"])
            self.assertEqual(result["remaining_observed_pids"], [])
            self.assertEqual(result["unreaped_observed_pids"], [])
            self.assertIsNotNone(app.returncode)
        finally:
            if app.poll() is None:
                os.killpg(app.pid, signal.SIGKILL)
                app.wait(timeout=3)
            app.stdout.close()


if __name__ == "__main__":
    unittest.main()
