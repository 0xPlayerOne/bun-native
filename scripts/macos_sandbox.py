"""Read-only Seatbelt presence observation, not a policy-equivalence certificate.

Uses the sandbox_check(pid, NULL, 0) contract also used by Chromium Seatbelt.
Only call for identities already owned and rechecked by the process observer.
Source: https://chromium.googlesource.com/chromium/src/+/refs/tags/122.0.6261.148/sandbox/mac/seatbelt.cc
"""

import ctypes
import sys

_CHECK = None
if sys.platform == "darwin":
    try:
        _LIBRARY = ctypes.CDLL("/usr/lib/system/libsystem_sandbox.dylib", use_errno=True)
        _CHECK = _LIBRARY.sandbox_check
        _CHECK.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        _CHECK.restype = ctypes.c_int
    except (OSError, AttributeError):
        pass


def presence(pid):
    if isinstance(pid, bool) or not isinstance(pid, int) or not 0 < pid < 2**31:
        raise ValueError("Invalid observed PID")
    if _CHECK is None:
        return {"provider": "macos-seatbelt-presence", "active": None, "error": "unavailable"}
    ctypes.set_errno(0)
    result = _CHECK(pid, None, 0)
    return {
        "provider": "macos-seatbelt-presence",
        "active": result == 1 if result in (0, 1) else None,
        "error": None if result in (0, 1) else "native-query-failed",
    }
