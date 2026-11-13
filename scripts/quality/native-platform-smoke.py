#!/usr/bin/env python3
"""Command-line entry point for native_harness.native_platform_smoke."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.quality.native_harness.native_platform_smoke import main

if __name__ == "__main__":
    raise SystemExit(main())
