"""Real process faults, not simulated PIDs. Run with python tests/process_observer_test.py."""

import importlib.util
import sys
import tempfile
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "observer", Path(__file__).parents[1] / "scripts/observe-process.py"
)
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def test_real_process_is_observed(self):
        # Wait for two actual sampler visits instead of assuming a 150 ms sleep
        # outlasts interpreter/sampler startup on a busy or emulated machine.
        # The first completed snapshot must exist before the child may exit.
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / "sampled"
            visits = 0

            def sampled(_pid):
                nonlocal visits
                visits += 1
                if visits == 1:
                    time.sleep(0.2)  # Reproduce observation slower than the old fixture.
                elif visits == 2:
                    release.write_text("observed", encoding="ascii")
                return {
                    "provider": "test-lifecycle-handshake",
                    "status": "unavailable",
                    "reason": "not a kernel counter",
                    "counters": [],
                    "expectedScopes": 0,
                    "sampledScopes": 0,
                }

            code = (
                "import time,json,sys; from pathlib import Path\n"
                "deadline=time.monotonic()+10\n"
                "while not Path(sys.argv[1]).exists():\n"
                " if time.monotonic()>deadline: raise RuntimeError('Sampler did not observe child')\n"
                " time.sleep(.01)\n"
                "print(json.dumps({'passed':True}))"
            )
            result = observer.observe(
                [sys.executable, "-c", code, str(release)], timeout=12, counter_reader=sampled
            )
        self.assertGreaterEqual(visits, 2)
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["timedOut"])
        self.assertTrue(result["reports"][-1]["passed"])
        self.assertGreater(result["peakTreeRssBytes"], 0)
        self.assertEqual(result["observedOrphans"], [])

    def test_large_bounded_json_report_is_not_split(self):
        result = observer.observe(
            [
                sys.executable,
                "-c",
                'import json; print(json.dumps({"passed":True,"data":"x"*100000}))',
            ]
        )
        self.assertTrue(result["reports"][-1]["passed"])
        self.assertEqual(len(result["reports"][-1]["data"]), 100000)

    def test_output_overflow_is_not_success(self):
        result = observer.observe([sys.executable, "-c", 'print("x"*3000000)'])
        self.assertTrue(result["outputOverflow"])

    def test_hang_is_bounded_and_not_a_success(self):
        result = observer.observe(
            [sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.15
        )
        self.assertTrue(result["timedOut"])
        self.assertNotEqual(result["exitCode"], 0)

    def test_crash_is_preserved_as_failure(self):
        result = observer.observe(
            [sys.executable, "-c", "import time,sys; time.sleep(.1); sys.exit(23)"]
        )
        self.assertEqual(result["exitCode"], 23)

    def test_orphan_is_detected_before_owned_cleanup(self):
        code = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(.3)'
        result = observer.observe([sys.executable, "-c", code])
        self.assertGreaterEqual(result["observedProcesses"], 2)
        self.assertEqual(len(result["observedOrphans"]), 1)
        self.assertEqual(result["orphanDetails"][0]["pid"], result["observedOrphans"][0])
        self.assertTrue(result["orphanDetails"][0]["name"])
        self.assertNotIn("commandLine", result["orphanDetails"][0])


if __name__ == "__main__":
    unittest.main()
