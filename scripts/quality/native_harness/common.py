"""Helpers shared by the native harness drivers and verifiers."""

import hashlib
import signal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parent


def harness_sources():
    """Repository-relative paths of every module in this package."""
    return sorted(path.relative_to(ROOT).as_posix() for path in PACKAGE.glob("*.py"))


def fingerprint(path):
    """SHA-256 and size of one file, read in bounded chunks."""
    path = Path(path)
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"sha256": digest, "bytes": path.stat().st_size}


def interrupt_handler(name):
    """A SIGTERM/SIGALRM handler that ignores repeats so cleanup can finish."""

    def interrupt(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGALRM, signal.SIG_IGN)
        raise InterruptedError(f"{name} received signal {signum}")

    return interrupt
