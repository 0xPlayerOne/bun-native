#!/usr/bin/env python3
"""Command-line entry point for native_harness.warm_gpu_driver."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.quality.native_harness.warm_gpu_driver import main

if __name__ == "__main__":
    raise SystemExit(main())
