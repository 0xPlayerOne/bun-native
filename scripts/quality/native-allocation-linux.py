#!/usr/bin/env python3
"""Command-line entry point for native_harness.native_allocation_linux."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.quality.native_harness.native_allocation_linux import (
    exec_postprocessor,
    main,
)

if __name__ == "__main__":
    if sys.argv[1:2] == ["--bounded-exec"]:
        exec_postprocessor(sys.argv[2:])
    sys.exit(main())
