"""Fixed loopback server descendant; finite lifetime even if supervision regresses."""

import json
import os
import signal
import socket
import sys
import threading

if sys.platform != "win32":
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.alarm(20)
else:
    watchdog = threading.Timer(20, lambda: os._exit(125))
    watchdog.daemon = True
    watchdog.start()
try:
    os.fstat(3)
    control_inherited = True
except OSError:
    control_inherited = False


def inherited(fd):
    try:
        os.fstat(fd)
        return True
    except OSError:
        return False


host_inherited = inherited(4) or inherited(int(os.environ.get("BUNLY_FIXTURE_SOURCE_FD", "-1")))
with socket.socket() as server:
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    print(
        json.dumps(
            {
                "event": "ready",
                "server": os.getpid(),
                "shell": os.getppid(),
                "group": os.getpgrp() if sys.platform != "win32" else None,
                "port": server.getsockname()[1],
                "controlInherited": control_inherited,
                "hostInherited": host_inherited,
                "emptyArgPreserved": sys.argv[1:] == [""],
            }
        ),
        flush=True,
    )
    for line in sys.stdin:
        if line.strip() == "exit":
            print("FINAL-" + "x" * 8192, flush=True)
            sys.exit(7)
