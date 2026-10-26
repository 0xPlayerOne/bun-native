"""Fixed loopback server descendant; finite lifetime even if supervision regresses."""

import json
import os
import signal
import socket
import sys

signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.alarm(20)
try:
    os.fstat(3)
    control_inherited = True
except OSError:
    control_inherited = False
with socket.socket() as server:
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    print(
        json.dumps(
            {
                "event": "ready",
                "server": os.getpid(),
                "shell": os.getppid(),
                "group": os.getpgrp(),
                "port": server.getsockname()[1],
                "controlInherited": control_inherited,
            }
        ),
        flush=True,
    )
    for line in sys.stdin:
        if line.strip() == "exit":
            print("FINAL-" + "x" * 8192, flush=True)
            sys.exit(7)
