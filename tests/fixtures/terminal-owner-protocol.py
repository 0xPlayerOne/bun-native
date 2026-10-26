"""Finite protocol adversary. Never launches an application command."""

import os
import socket
import sys
import time

mode = sys.argv[1]
with (
    open(os.environ["BUNLY_TERMINAL_CONTROL"], "r+b", buffering=0)
    if sys.platform == "win32"
    else socket.socket(fileno=3)
) as pipe:
    if sys.platform == "win32":
        send = pipe.write
        receive = pipe.read
    else:
        pipe.settimeout(2)
        send = pipe.sendall
        receive = pipe.recv
    try:
        if mode == "early-eof":
            sys.exit(125)
        if mode == "bad-version":
            send(bytes([66, 84, 79, 99]))
            time.sleep(1)
            sys.exit(125)
        if mode == "late-hello":
            time.sleep(0.3)
        send(bytes([66, 84, 79, 2]))
        if receive(1) != b"\0":
            sys.exit(125)
        if mode == "no-command":
            send(bytes([4, 2]))
            sys.exit(125)
        if mode == "late-ready":
            time.sleep(0.3)
        if mode == "malformed":
            send(bytes([99]))
        elif mode == "oversized":
            send(bytes([1, 2, 0]) + b"x" * 4096)
        elif mode == "callback":
            send(bytes([1]))
            print("callback", flush=True)
        else:
            send(bytes([1]))
        receive(1)
    except (OSError, ValueError):
        pass
