"""Bounded contributor-only libproc identity reads; no process is signalled here.

The 56-byte PROC_PIDUNIQIDENTIFIERINFO ABI and retained original-parent unique ID
come from Apple's XNU headers. See docs/macos-clone-cleanup.md for provenance.
Unavailable or short kernel replies never establish ownership.
"""

import ctypes
import os
import struct
from dataclasses import dataclass

MAX_PID_CANDIDATES = 4096
PROC_PIDUNIQIDENTIFIERINFO = 17
PROC_RUID_ONLY = 5
IDENTITY_BYTES = 56


@dataclass(frozen=True)
class KernelIdentity:
    unique_id: int
    parent_unique_id: int
    version: int
    executable_uuid: bytes


def decode_identity(data):
    if len(data) != IDENTITY_BYTES:
        return None
    uuid, unique_id, parent_unique_id, version, _parent_version, _reserved2, _reserved3 = (
        struct.unpack("=16sQQiiQQ", data)
    )
    if unique_id == 0 or parent_unique_id == 0 or version < 0:
        return None
    return KernelIdentity(unique_id, parent_unique_id, version, uuid)


class MacProcessIds:
    def __init__(self):
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self._pidinfo = library.proc_pidinfo
        self._pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        self._pidinfo.restype = ctypes.c_int
        self._listpids = library.proc_listpids
        self._listpids.argtypes = [
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        self._listpids.restype = ctypes.c_int

    def identity(self, pid):
        if not isinstance(pid, int) or not 0 < pid < 2**31:
            return None
        buffer = ctypes.create_string_buffer(IDENTITY_BYTES)
        size = self._pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, buffer, IDENTITY_BYTES)
        return decode_identity(buffer.raw) if size == IDENTITY_BYTES else None

    def same_uid_pids(self):
        # One fixed allocation/call, including an overflow sentinel. Never size
        # an allocation using a process count supplied by the operating system.
        buffer = (ctypes.c_int * (MAX_PID_CANDIDATES + 1))()
        size = self._listpids(PROC_RUID_ONLY, os.getuid(), buffer, ctypes.sizeof(buffer))
        width = ctypes.sizeof(ctypes.c_int)
        if size <= 0 or size % width or size > MAX_PID_CANDIDATES * width:
            raise ValueError("kernel-process-inventory-unavailable-or-overfull")
        pids = list(buffer[: size // width])
        if any(pid <= 0 for pid in pids) or len(set(pids)) != len(pids):
            raise ValueError("malformed-kernel-process-inventory")
        return pids
