"""Capture one owned X11 window to PNG inside the calling driver process.

The driver previously forked ImageMagick `import` for every screenshot. Under a
loaded hosted runner most of that command's time is process start-up and
library/coder initialisation, not the X request itself, and that cost is what
exceeded the fixed 3-second capture bound (run 41753263629). This module issues
the same XGetImage request through the already-installed libX11 and encodes
the pixels with the standard library, so the bound covers only the capture.
"""

import ctypes
import ctypes.util
import struct
import threading
import time
import zlib

Z_PIXMAP = 2
ALL_PLANES = 0xFFFFFFFF
LSB_FIRST = 0
MAX_PIXELS = 8192 * 8192


class XImage(ctypes.Structure):
    # Leading public fields of Xlib's XImage; only these are read.
    _fields_ = [
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("xoffset", ctypes.c_int),
        ("format", ctypes.c_int),
        ("data", ctypes.c_void_p),
        ("byte_order", ctypes.c_int),
        ("bitmap_unit", ctypes.c_int),
        ("bitmap_bit_order", ctypes.c_int),
        ("bitmap_pad", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("bytes_per_line", ctypes.c_int),
        ("bits_per_pixel", ctypes.c_int),
        ("red_mask", ctypes.c_ulong),
        ("green_mask", ctypes.c_ulong),
        ("blue_mask", ctypes.c_ulong),
    ]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", ctypes.c_ulong),
        ("window_class", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class XErrorEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("resourceid", ctypes.c_ulong),
        ("serial", ctypes.c_ulong),
        ("error_code", ctypes.c_ubyte),
        ("request_code", ctypes.c_ubyte),
        ("minor_code", ctypes.c_ubyte),
    ]


ERROR_HANDLER = ctypes.CFUNCTYPE(
    ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(XErrorEvent)
)
_lock = threading.Lock()
_library = None
_errors = {}


@ERROR_HANDLER
def _record_error(display, event):
    # Xlib's default handler exits the whole driver process. Record the
    # protocol error for the failing connection and let the call return NULL.
    _errors.setdefault(display, event.contents.error_code)
    return 0


def _x11():
    global _library
    with _lock:
        if _library is None:
            name = ctypes.util.find_library("X11") or "libX11.so.6"
            library = ctypes.CDLL(name)
            library.XOpenDisplay.restype = ctypes.c_void_p
            library.XOpenDisplay.argtypes = [ctypes.c_char_p]
            library.XCloseDisplay.argtypes = [ctypes.c_void_p]
            library.XGetWindowAttributes.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.POINTER(XWindowAttributes),
            ]
            library.XGetImage.restype = ctypes.POINTER(XImage)
            library.XGetImage.argtypes = [
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_uint,
                ctypes.c_uint,
                ctypes.c_ulong,
                ctypes.c_int,
            ]
            library.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
            library.XFree.argtypes = [ctypes.c_void_p]
            library.XSetErrorHandler.restype = ctypes.c_void_p
            library.XSetErrorHandler.argtypes = [ERROR_HANDLER]
            library.XSetErrorHandler(_record_error)
            _library = library
        return _library


def png_bytes(width, height, rgb_rows):
    """Encode 8-bit RGB scanlines (filter byte 0 already prefixed) as PNG."""

    def chunk(kind, body):
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body))
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rgb_rows, 6))
        + chunk(b"IEND", b"")
    )


def rgb_rows(raw, width, height, bytes_per_line):
    """Convert little-endian 32-bit 0x00RRGGBB pixels to PNG RGB scanlines."""
    rows = bytearray()
    for y in range(height):
        start = y * bytes_per_line
        pixels = raw[start : start + width * 4]
        rgb = bytearray(width * 3)
        rgb[0::3] = pixels[2::4]
        rgb[1::3] = pixels[1::4]
        rgb[2::3] = pixels[0::4]
        rows += b"\0"
        rows += rgb
    return bytes(rows)


def _capture(window):
    x11 = _x11()
    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Cannot open the owned X display for window capture")
    try:
        attributes = XWindowAttributes()
        if not x11.XGetWindowAttributes(display, window, ctypes.byref(attributes)):
            raise RuntimeError("Captured window attributes are unavailable")
        width, height = attributes.width, attributes.height
        if not (0 < width and 0 < height and width * height <= MAX_PIXELS):
            raise RuntimeError("Captured window has invalid dimensions")
        image = x11.XGetImage(
            display, window, 0, 0, width, height, ALL_PLANES, Z_PIXMAP
        )
        x11.XSync(display, 0)
        error = _errors.pop(display, None)
        if error is not None or not image:
            raise RuntimeError(
                f"XGetImage failed for the owned window (X error {error})"
            )
        try:
            fields = image.contents
            if (
                fields.bits_per_pixel != 32
                or fields.byte_order != LSB_FIRST
                or (fields.red_mask, fields.green_mask, fields.blue_mask)
                != (0xFF0000, 0xFF00, 0xFF)
                or (fields.width, fields.height) != (width, height)
                or fields.bytes_per_line < width * 4
            ):
                raise RuntimeError("Owned window visual is not 32-bit TrueColor BGRX")
            raw = ctypes.string_at(fields.data, fields.bytes_per_line * height)
            stride = fields.bytes_per_line
        finally:
            # XDestroyImage is a macro; free the pixel buffer and the struct.
            x11.XFree(image.contents.data)
            x11.XFree(image)
    finally:
        _errors.pop(display, None)
        x11.XCloseDisplay(display)
    return width, height, rgb_rows(raw, width, height, stride)


def capture_png(window, path, timeout=3):
    """Write one exclusive PNG of the window within the caller's fixed bound."""
    window = int(window)
    result = {}

    def work():
        try:
            result["value"] = _capture(window)
        except BaseException as error:  # noqa: BLE001 - re-raised by the caller
            result["error"] = error

    started = time.monotonic()
    # A blocked X request cannot be cancelled; the bounded join keeps the
    # original deadline and the daemon worker never outlives the driver.
    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise TimeoutError(f"Window capture exceeded its {timeout}-second bound")
    if "error" in result:
        raise result["error"]
    width, height, rows = result["value"]
    encoded = png_bytes(width, height, rows)
    elapsed = time.monotonic() - started
    if elapsed > timeout:
        raise TimeoutError(f"Window capture exceeded its {timeout}-second bound")
    with open(path, "xb") as output:
        output.write(encoded)
    return {"width": width, "height": height, "capture_ms": elapsed * 1000}
