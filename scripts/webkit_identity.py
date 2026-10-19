"""Installed system WebKit build identity. Not a user-agent or process sandbox assertion."""

import hashlib
import json
import plistlib
import subprocess
import sys
from pathlib import Path


def parse(raw):
    value = plistlib.loads(raw)
    version = value.get("CFBundleVersion")
    if (
        not isinstance(version, str)
        or not version
        or not all(c.isdigit() or c == "." for c in version)
    ):
        raise ValueError("Missing exact installed WebKit version")
    return {
        "provider": "system-webkit-framework-plist",
        "bundleVersion": version,
        "shortVersion": value.get("CFBundleShortVersionString"),
        "manifestSha256": hashlib.sha256(raw).hexdigest(),
        "scope": "installed-system-framework; no per-process library-attestation claim",
    }


if __name__ == "__main__":
    if sys.platform != "darwin":
        raise SystemExit("This system WebKit provider requires macOS")
    result = parse(
        Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").read_bytes()
    )
    version = subprocess.run(
        ["/usr/bin/sw_vers", "-buildVersion"], check=True, capture_output=True, text=True, timeout=5
    )
    result["osBuild"] = version.stdout.strip()
    print(json.dumps(result))
