"""Keep the launched PID live until its owner anchors identity, then exec argv."""

import os
import select
import sys


def main():
    if len(sys.argv) < 3:
        raise ValueError("A private read descriptor and an executable are required")
    descriptor = int(sys.argv[1])
    if descriptor < 3:
        raise ValueError("The start descriptor must not replace a standard stream")
    try:
        readable, _, _ = select.select([descriptor], [], [], 5)
        if not readable or os.read(descriptor, 1) != b"!":
            raise RuntimeError("Owned command start handshake was not released")
    finally:
        os.close(descriptor)
    # Same PID, cwd, environment and original argument vector; no shell layer.
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
