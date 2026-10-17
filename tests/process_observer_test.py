"""Real process faults, not simulated PIDs. Run with python tests/process_observer_test.py."""
import importlib.util
import sys
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('observer', Path(__file__).parents[1] / 'scripts/observe-process.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserverTests(unittest.TestCase):
    def test_real_process_is_observed(self):
        result = observer.observe([sys.executable, '-c', 'import time,json; time.sleep(.15); print(json.dumps({"passed":True}))'])
        self.assertEqual(result['exitCode'], 0)
        self.assertTrue(result['reports'][-1]['passed'])
        self.assertGreater(result['peakTreeRssBytes'], 0)
        self.assertEqual(result['observedOrphans'], [])

    def test_hang_is_bounded_and_not_a_success(self):
        result = observer.observe([sys.executable, '-c', 'import time; time.sleep(30)'], timeout=.15)
        self.assertTrue(result['timedOut'])
        self.assertNotEqual(result['exitCode'], 0)

    def test_crash_is_preserved_as_failure(self):
        result = observer.observe([sys.executable, '-c', 'import time,sys; time.sleep(.1); sys.exit(23)'])
        self.assertEqual(result['exitCode'], 23)

    def test_orphan_is_detected_before_owned_cleanup(self):
        code = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(.3)'
        result = observer.observe([sys.executable, '-c', code])
        self.assertGreaterEqual(result['observedProcesses'], 2)
        self.assertEqual(len(result['observedOrphans']), 1)


if __name__ == '__main__':
    unittest.main()
