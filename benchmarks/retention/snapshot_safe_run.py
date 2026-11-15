"""Run an isolated diagnostic with only environment needed by the OS/runtime."""

import os
import subprocess
import sys


ALLOWED = {
    "APPDATA",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
}


def safe_environment(source):
    return {key: value for key, value in source.items() if key.upper() in ALLOWED}


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Expected a diagnostic executable")
    result = subprocess.run(sys.argv[1:], env=safe_environment(os.environ), check=False)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
