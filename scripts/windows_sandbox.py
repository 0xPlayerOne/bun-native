"""Read-only token/job observations for already identity-checked owned processes.

These snapshots cannot certify a Chromium policy or its full process lifetime.
No privilege is enabled and no process/token/job is modified.
API contracts: Microsoft OpenProcessToken, GetTokenInformation, IsTokenRestricted,
IsProcessInJob; TOKEN_INFORMATION_CLASS in winnt.h. Native Windows execution is
required separately from the portable classification tests.
"""

import ctypes
import sys

PROVIDER = "windows-token-job-v1"
DWORD = ctypes.c_uint32
BOOL = ctypes.c_int32
HANDLE = ctypes.c_void_p


class Label(ctypes.Structure):
    _fields_ = [("sid", ctypes.c_void_p), ("attributes", DWORD)]


def integrity_rid(buffer, length):
    """Bounds-check the kernel's inline mandatory-label SID before reading its RID."""
    if length < ctypes.sizeof(Label) or length > ctypes.sizeof(buffer):
        raise ValueError("Invalid token label length")
    base = ctypes.addressof(buffer)
    label = Label.from_buffer(buffer)
    address = label.sid
    if address is None or address < base + ctypes.sizeof(Label) or address + 8 > base + length:
        raise ValueError("Invalid token SID pointer")
    header = ctypes.string_at(address, 8)
    count = header[1]
    if header[0] != 1 or not 1 <= count <= 15 or header[2:] != bytes([0, 0, 0, 0, 0, 16]):
        raise ValueError("Invalid mandatory-label SID")
    if address + 8 + count * 4 > base + length:
        raise ValueError("Truncated mandatory-label SID")
    return DWORD.from_address(address + 8 + (count - 1) * 4).value


def classify(rid, restricted, container, in_job):
    if (
        type(rid) is not int
        or not 0 <= rid <= 0xFFFF
        or any(type(v) is not bool for v in (restricted, container, in_job))
    ):
        raise ValueError("Invalid native token observations")
    return {
        "provider": PROVIDER,
        "available": True,
        "integrityRid": rid,
        "restrictedSids": restricted,
        "appContainer": container,
        "inJob": in_job,
        "isolationObserved": rid <= 0x1000 and (restricted or container) and in_job,
        "scope": "token/job snapshot only, not sandbox policy equivalence or continuous attestation",
    }


class Native:
    def __init__(self):
        self.kernel = ctypes.WinDLL("kernel32.dll", use_last_error=True, winmode=0x800)
        self.security = ctypes.WinDLL("advapi32.dll", use_last_error=True, winmode=0x800)
        signatures = [
            (self.kernel.OpenProcess, [DWORD, BOOL, DWORD], HANDLE),
            (self.kernel.CloseHandle, [HANDLE], BOOL),
            (self.kernel.IsProcessInJob, [HANDLE, HANDLE, ctypes.POINTER(BOOL)], BOOL),
            (self.security.OpenProcessToken, [HANDLE, DWORD, ctypes.POINTER(HANDLE)], BOOL),
            (
                self.security.GetTokenInformation,
                [HANDLE, ctypes.c_int, ctypes.c_void_p, DWORD, ctypes.POINTER(DWORD)],
                BOOL,
            ),
            (self.security.IsTokenRestricted, [HANDLE], BOOL),
        ]
        for function, arguments, result in signatures:
            function.argtypes, function.restype = arguments, result

    def query(self, token, kind):
        needed = DWORD()
        ctypes.set_last_error(0)
        self.security.GetTokenInformation(token, kind, None, 0, ctypes.byref(needed))
        if ctypes.get_last_error() != 122 or not 4 <= needed.value <= 16384:
            raise OSError("Cannot size token information")
        buffer = ctypes.create_string_buffer(needed.value)
        if not self.security.GetTokenInformation(
            token, kind, buffer, len(buffer), ctypes.byref(needed)
        ):
            raise OSError("Cannot query token information")
        return buffer, needed.value

    def capture(self, pid):
        process = self.kernel.OpenProcess(0x1000, False, pid)
        if not process:
            raise OSError("Cannot query process")
        token = HANDLE()
        try:
            if not self.security.OpenProcessToken(process, 0x8, ctypes.byref(token)):
                raise OSError("Cannot query process token")
            kind, length = self.query(token, 8)  # TokenType
            if length != 4 or DWORD.from_buffer(kind).value != 1:
                raise ValueError("Expected process primary token")
            label, length = self.query(token, 25)  # TokenIntegrityLevel
            rid = integrity_rid(label, length)
            app, length = self.query(token, 29)  # TokenIsAppContainer
            if length != 4 or DWORD.from_buffer(app).value not in (0, 1):
                raise ValueError("Invalid app-container result")
            job = BOOL()
            if not self.kernel.IsProcessInJob(process, None, ctypes.byref(job)):
                raise OSError("Cannot query job membership")
            return classify(
                rid,
                bool(self.security.IsTokenRestricted(token)),
                bool(DWORD.from_buffer(app).value),
                bool(job.value),
            )
        finally:
            if token.value:
                self.kernel.CloseHandle(token)
            self.kernel.CloseHandle(process)


_NATIVE = None


def presence(pid):
    global _NATIVE
    if type(pid) is not int or not 0 < pid < 2**31:
        raise ValueError("Invalid observed PID")
    if sys.platform != "win32":
        return {
            "provider": PROVIDER,
            "available": False,
            "isolationObserved": None,
            "error": "unsupported-platform",
        }
    try:
        if _NATIVE is None:
            _NATIVE = Native()
        return _NATIVE.capture(pid)
    except (OSError, ValueError, AttributeError):
        return {
            "provider": PROVIDER,
            "available": False,
            "isolationObserved": None,
            "error": "unavailable-or-incomplete",
        }
