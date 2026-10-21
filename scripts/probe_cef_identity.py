"""Run only under a bounded process observer: loading a native library executes code.

The caller must explicitly select trusted installed bytes and pin their SHA-256.
This is version inspection, NOT sandbox attestation or publisher authentication.
Public ABI: chromiumembedded/cef/include/cef_version_info.h, cef_version_info(0..7).
"""

import argparse
import ctypes
import hashlib
import json
import re
import stat
from pathlib import Path


def verified_library(filename, expected):
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("A pinned SHA-256 is required")
    path = Path(filename)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size < 1 or before.st_size > 2**31:
        raise ValueError("Expected a bounded regular native library, not a link")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
    after = path.lstat()

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    if identity(before) != identity(after) or digest.hexdigest() != expected:
        raise ValueError("Native library identity mismatch")
    return path.resolve(), identity(after)


def inspect(filename, expected):
    path, identity = verified_library(filename, expected)
    library = ctypes.CDLL(str(path))
    version = library.cef_version_info
    version.argtypes = [ctypes.c_int]
    version.restype = ctypes.c_int
    parts = [version(index) for index in range(8)]
    if (
        any(not isinstance(n, int) or n < 0 or n > 2**31 - 1 for n in parts)
        or not parts[0]
        or not parts[4]
    ):
        raise ValueError("Invalid exported CEF version components")
    full = None
    try:
        full_function = library.cef_version_full
    except AttributeError:
        pass
    else:
        full_function.argtypes = []
        full_function.restype = ctypes.c_char_p
        raw = full_function()
        if raw is None or len(raw) > 256 or not re.fullmatch(rb"[a-zA-Z0-9.+_-]+", raw):
            raise ValueError("Invalid full CEF version string")
        full = raw.decode("ascii")
    _, after_identity = verified_library(filename, expected)
    if identity != after_identity:
        raise ValueError("Native library changed during inspection")
    return {
        "event": "cef-binary-identity",
        "schema": 1,
        "sha256": expected,
        "cefVersion": ".".join(map(str, parts[:3])),
        "cefCommitNumber": parts[3],
        "chromiumVersion": ".".join(map(str, parts[4:])),
        "fullVersion": full,
        "source": "exported-api",
        "sandbox": "unverified",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.library, args.sha256)))
    except (OSError, AttributeError, ValueError) as error:
        # Never print loader paths, environment variables or arbitrary native text.
        print(json.dumps({"event": "cef-identity-failure", "error": type(error).__name__}))
        raise SystemExit(1) from None
