#!/usr/bin/env python3
"""Command-line entry point for native_harness.solid_window."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.quality.native_harness.solid_window import main

if __name__ == "__main__":
    main()
