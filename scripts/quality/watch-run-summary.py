#!/usr/bin/env python3
"""Command-line entry point for native_harness.watch_run_summary."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.quality.native_harness.watch_run_summary import main

if __name__ == "__main__":
    main(sys.argv)
