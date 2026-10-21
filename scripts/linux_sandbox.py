"""Read-only Linux process isolation observations; never a policy-equivalence claim.

/proc/<pid>/status fields are defined by Linux Documentation/filesystems/proc.rst.
The caller must check the PID/creation identity before and after this observation.
No sysctl, permission, namespace, or sandbox configuration is changed.
"""

import re
import sys
from pathlib import Path

PROVIDER = "linux-proc-status-v1"


def parse_status(text):
    required = {"Seccomp", "NoNewPrivs", "CapEff", "NSpid"}
    fields = {}
    for line in text.splitlines():
        name, separator, value = line.partition(":")
        if separator and name in required:
            if name in fields:
                raise ValueError("Duplicate isolation field")
            fields[name] = value.strip()
    if set(fields) != required:
        raise ValueError("Missing isolation fields")
    if fields["Seccomp"] not in ("0", "1", "2") or fields["NoNewPrivs"] not in ("0", "1"):
        raise ValueError("Invalid process isolation mode")
    if not re.fullmatch(r"[a-fA-F0-9]{1,16}", fields["CapEff"]):
        raise ValueError("Invalid capabilities")
    pids = fields["NSpid"].split()
    if not 1 <= len(pids) <= 32 or any(not p.isdigit() or not 0 < int(p) < 2**31 for p in pids):
        raise ValueError("Invalid namespace identities")
    filtered = fields["Seccomp"] == "2"
    no_new = fields["NoNewPrivs"] == "1"
    no_caps = int(fields["CapEff"], 16) == 0
    return {
        "provider": PROVIDER,
        "available": True,
        "seccompFilter": filtered,
        "noNewPrivileges": no_new,
        "effectiveCapabilitiesZero": no_caps,
        "namespacePidDepth": len(pids),
        "isolationObserved": filtered and no_new and no_caps and len(pids) > 1,
        "scope": "proc-status snapshot, not seccomp-policy audit or continuous sandbox guarantee",
    }


def presence(pid):
    if type(pid) is not int or not 0 < pid < 2**31:
        raise ValueError("Invalid observed PID")
    if sys.platform != "linux":
        return {
            "provider": PROVIDER,
            "available": False,
            "isolationObserved": None,
            "error": "unsupported-platform",
        }
    try:
        with Path(f"/proc/{pid}/status").open("rb") as file:
            data = file.read(16385)
        if len(data) > 16384:
            raise ValueError("Oversized process status")
        return parse_status(data.decode("ascii"))
    except (OSError, ValueError, UnicodeError):
        return {
            "provider": PROVIDER,
            "available": False,
            "isolationObserved": None,
            "error": "unavailable-or-incomplete",
        }
