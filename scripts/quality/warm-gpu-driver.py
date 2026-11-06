"""Read the software GPU driver's shared-library closure into the page cache.

Hosted Linux runners load Mesa Lavapipe (and LLVM, which it links) from a
cold disk the first time a GPUI window opens. That first touch of roughly
200 MB of driver code lands inside the first `open` request, before GPUI's
first Vulkan instance record (#296). This step pays it once, outside any
product request, and records what it found so the cost stays measured:

- `resident_before_bytes`: pages already cached before the read (mincore)
- `read_seconds`: wall time to read the file

It never changes a deadline, a backend or the driver that tests use.
"""

import argparse
import ctypes
import ctypes.util
import json
import mmap
import os
import re
import subprocess
import time
from pathlib import Path

CHUNK = 1 << 20
MAX_FILES = 64
MAX_TOTAL_BYTES = 2 << 30
EGL_VENDOR_DIRECTORIES = (Path("/usr/share/glvnd/egl_vendor.d"),)
LDD_LINE = re.compile(r"^\s*(?:\S+\s+=>\s+)?(/\S+)\s+\(0x[0-9a-f]+\)\s*$")


def icd_library(manifest: Path) -> str:
    document = json.loads(manifest.read_text())
    library = document.get("ICD", {}).get("library_path")
    if not isinstance(library, str) or not library:
        raise ValueError(f"{manifest} has no ICD.library_path")
    return library


def egl_vendor_libraries(directories=EGL_VENDOR_DIRECTORIES) -> list[str]:
    libraries = []
    for directory in directories:
        for manifest in sorted(directory.glob("*mesa*.json")):
            library = (
                json.loads(manifest.read_text()).get("ICD", {}).get("library_path")
            )
            if isinstance(library, str) and library:
                libraries.append(library)
    return libraries


def resolve(library: str, ldconfig_output: str) -> Path | None:
    if library.startswith("/"):
        return Path(library)
    for line in ldconfig_output.splitlines():
        name, _, location = line.strip().partition(" => ")
        if name.split(" ", 1)[0] == library and location.startswith("/"):
            return Path(location)
    return None


def ldd_dependencies(ldd_output: str) -> list[Path]:
    paths = []
    for line in ldd_output.splitlines():
        match = LDD_LINE.match(line)
        if match:
            paths.append(Path(match.group(1)))
    return paths


def closure(roots: list[Path]) -> list[Path]:
    files: dict[Path, None] = {}
    for root in roots:
        files[root.resolve()] = None
        output = subprocess.run(
            ["ldd", str(root)], check=True, capture_output=True, text=True, timeout=30
        ).stdout
        for dependency in ldd_dependencies(output):
            files[dependency.resolve()] = None
    return list(files)


def resident_bytes(path: Path) -> int | None:
    """Count cached bytes with mincore(2) without faulting any page in."""
    size = path.stat().st_size
    if size == 0:
        return 0
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    libc.mmap.restype = ctypes.c_void_p
    libc.mmap.argtypes = (
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_long,
    )
    libc.munmap.argtypes = (ctypes.c_void_p, ctypes.c_size_t)
    libc.mincore.argtypes = (ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p)
    page = mmap.PAGESIZE
    pages = (size + page - 1) // page
    descriptor = os.open(path, os.O_RDONLY)
    try:
        address = libc.mmap(None, size, mmap.PROT_READ, mmap.MAP_SHARED, descriptor, 0)
        if address in (None, ctypes.c_void_p(-1).value):
            return None
        try:
            vector = ctypes.create_string_buffer(pages)
            if libc.mincore(address, size, vector) != 0:
                return None
            resident = sum(byte & 1 for byte in vector.raw)
        finally:
            libc.munmap(address, size)
    finally:
        os.close(descriptor)
    return min(resident * page, size)


def read_file(path: Path) -> float:
    started = time.monotonic()
    with path.open("rb", buffering=0) as handle:
        while handle.read(CHUNK):
            pass
    return time.monotonic() - started


def warm(files: list[Path]) -> dict:
    if len(files) > MAX_FILES:
        raise ValueError(f"driver closure has {len(files)} files, above {MAX_FILES}")
    total = sum(path.stat().st_size for path in files)
    if total > MAX_TOTAL_BYTES:
        raise ValueError(f"driver closure is {total} bytes, above {MAX_TOTAL_BYTES}")
    records = []
    started = time.monotonic()
    for path in files:
        before = resident_bytes(path)
        seconds = read_file(path)
        records.append(
            {
                "path": str(path),
                "bytes": path.stat().st_size,
                "resident_before_bytes": before,
                "read_seconds": round(seconds, 6),
            }
        )
    return {
        "schema": "bun-native.gpu-driver-warmup.v1",
        "files": records,
        "total_bytes": total,
        "resident_before_bytes": sum(
            record["resident_before_bytes"] or 0 for record in records
        ),
        "read_seconds": round(time.monotonic() - started, 6),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    manifest = os.environ.get("VK_DRIVER_FILES")
    if not manifest:
        parser.error("VK_DRIVER_FILES must name the pinned Lavapipe ICD manifest")
    ldconfig = subprocess.run(
        ["ldconfig", "-p"], check=True, capture_output=True, text=True, timeout=30
    ).stdout
    roots = []
    for library in [icd_library(Path(manifest)), *egl_vendor_libraries()]:
        path = resolve(library, ldconfig)
        if path is None:
            raise FileNotFoundError(f"cannot resolve driver library {library}")
        roots.append(path)
    report = warm(closure(roots))
    report["vulkan_icd_manifest"] = manifest
    report["roots"] = [str(root) for root in roots]
    arguments.output.write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                "files": len(report["files"]),
                "total_bytes": report["total_bytes"],
                "resident_before_bytes": report["resident_before_bytes"],
                "read_seconds": report["read_seconds"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
