"""Strict public signing-policy parsing and immutable artifact inventories."""

import copy
import hashlib
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

RECEIPT = ".benchmark-native-signature.json"
MAX_JSON = 1024 * 1024


class SigningError(ValueError):
    """A stable, non-secret failure code suitable for stored benchmark reports."""


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise SigningError("duplicate-json-key")
        result[key] = value
    return result


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
    ).hexdigest()


def hex_value(value, length):
    return isinstance(value, str) and re.fullmatch(rf"[a-fA-F0-9]{{{length}}}", value) is not None


def relative_name(value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise SigningError("invalid-relative-path")
    parts = value.split("/")
    if (
        value.startswith("/")
        or any(p in ("", ".", "..") for p in parts)
        or any(ord(c) < 32 or ord(c) == 127 or c in '\\:*?"<>|' for c in value)
        or any(
            p.endswith((" ", "."))
            or re.fullmatch(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?", p)
            for p in parts
        )
    ):
        raise SigningError("invalid-relative-path")
    return value


def contained(workspace, name, exists=True):
    name = relative_name(name)
    cursor = Path(workspace).resolve()
    for part in name.split("/"):
        cursor = cursor / part
        if cursor.is_symlink():
            raise SigningError("linked-path")
        if cursor.exists() and getattr(cursor.lstat(), "st_file_attributes", 0) & 0x400:
            raise SigningError("reparse-point")
    if exists and not cursor.exists():
        raise SigningError("missing-input")
    return cursor


def read_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON:
        raise SigningError("invalid-json-file")
    data = path.read_bytes()
    if len(data) > MAX_JSON:
        raise SigningError("json-too-large")
    try:
        return json.loads(data, object_pairs_hook=pairs), data
    except (UnicodeError, json.JSONDecodeError) as error:
        raise SigningError("invalid-json") from error


def validate_policy(value):
    common = {"schema", "platform", "artifact", "certificateSha1", "targets"}
    if (
        not isinstance(value, dict)
        or type(value.get("schema")) is not int
        or value.get("schema") != 1
    ):
        raise SigningError("invalid-signing-policy")
    platform = value.get("platform")
    extra = {"teamId", "bundleIdentifier"} if platform == "darwin" else {"signtool", "timestampUrl"}
    if platform not in ("darwin", "win32") or set(value) != common | extra:
        raise SigningError("invalid-signing-policy-fields")
    artifact = relative_name(value["artifact"])
    if artifact.casefold() in (
        RECEIPT,
        ".benchmark-native-signing",
    ) or artifact.casefold().startswith((".benchmark-native-signing/", RECEIPT + "/")):
        raise SigningError("artifact-overlaps-signing-metadata")
    if not hex_value(value["certificateSha1"], 40):
        raise SigningError("explicit-certificate-required")
    targets = value["targets"]
    if not isinstance(targets, list) or not 1 <= len(targets) <= 256:
        raise SigningError("explicit-signing-targets-required")
    seen = set()
    for target in targets:
        if not isinstance(target, dict) or set(target) not in ({"path"}, {"path", "entitlements"}):
            raise SigningError("invalid-signing-target")
        name = relative_name(target["path"])
        if name != artifact and not name.startswith(artifact + "/"):
            raise SigningError("target-outside-artifact")
        if name.casefold() in seen:
            raise SigningError("duplicate-signing-target")
        # Every explicitly listed child must be signed before its containing bundle.
        if any(name.casefold().startswith(parent + "/") for parent in seen):
            raise SigningError("nested-signing-order")
        seen.add(name.casefold())
        entitlements = target.get("entitlements")
        if entitlements is not None:
            if (
                platform != "darwin"
                or not isinstance(entitlements, dict)
                or set(entitlements) != {"path", "sha256"}
            ):
                raise SigningError("invalid-entitlements")
            relative_name(entitlements["path"])
            if (
                not hex_value(entitlements["sha256"], 64)
                or entitlements["path"] == artifact
                or entitlements["path"].startswith(artifact + "/")
            ):
                raise SigningError("entitlements-must-be-pinned-outside-artifact")
        if platform == "win32" and PurePosixPath(name).suffix.lower() not in (".exe", ".dll"):
            raise SigningError("authenticode-target-must-be-pe")
    if platform == "darwin":
        if not artifact.endswith(".app") or targets[-1]["path"] != artifact:
            raise SigningError("root-app-must-be-signed-last")
        if (
            not isinstance(value["teamId"], str)
            or re.fullmatch(r"[A-Z0-9]{10}", value["teamId"]) is None
        ):
            raise SigningError("invalid-team-id")
        if (
            not isinstance(value["bundleIdentifier"], str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{1,254}", value["bundleIdentifier"]) is None
        ):
            raise SigningError("invalid-bundle-id")
    else:
        tool = value["signtool"]
        if (
            not isinstance(tool, dict)
            or set(tool) != {"path", "sha256"}
            or not isinstance(tool["path"], str)
            or not hex_value(tool["sha256"], 64)
        ):
            raise SigningError("pinned-signtool-required")
        # Validate Windows absolute paths even when generating the plan on Linux.
        if not re.fullmatch(r"[A-Za-z]:[/\\][^\x00\r\n]+[\\/]signtool\.exe", tool["path"], re.I):
            raise SigningError("absolute-sdk-signtool-required")
        timestamp = value["timestampUrl"]
        if (
            not isinstance(timestamp, str)
            or len(timestamp) > 2048
            or any(c.isspace() or ord(c) < 32 for c in timestamp)
        ):
            raise SigningError("explicit-https-timestamp-required")
        try:
            url = urlsplit(timestamp)
            _port = url.port
        except ValueError as error:
            raise SigningError("invalid-timestamp-url") from error
        if (
            not url
            or url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.fragment
            or url.query
        ):
            raise SigningError("explicit-https-timestamp-required")
    return copy.deepcopy(value)


def load_policy(workspace, name, expected_sha256):
    if not hex_value(expected_sha256, 64):
        raise SigningError("policy-digest-required")
    value, raw = read_json(contained(workspace, name))
    if hashlib.sha256(raw).hexdigest() != expected_sha256.lower():
        raise SigningError("policy-digest-mismatch")
    policy = validate_policy(value)
    if name.casefold() == policy["artifact"].casefold() or name.casefold().startswith(
        policy["artifact"].casefold() + "/"
    ):
        raise SigningError("policy-inside-artifact")
    return policy


def snapshot(root):
    """Bounded content/mode/link inventory; not ACLs, xattrs or power-loss durability."""
    root = Path(root)
    paths = [root]
    if root.is_dir():
        # Incrementally bound traversal instead of materializing an unbounded rglob.
        for base, dirs, files in os.walk(root, followlinks=False):
            for name in sorted(dirs + files):
                paths.append(Path(base) / name)
                if len(paths) > 100000:
                    raise SigningError("artifact-entry-budget")
    result = {}
    aliases = set()
    for path in paths:
        info = path.lstat()
        name = path.relative_to(root).as_posix() if path != root else "."
        if name.casefold() in aliases:
            raise SigningError("artifact-case-alias")
        aliases.add(name.casefold())
        row = {"mode": stat.S_IMODE(info.st_mode)}
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            if (
                path == root
                or Path(target).is_absolute()
                or not path.resolve(strict=True).is_relative_to(root.resolve())
            ):
                raise SigningError("escaping-artifact-link")
            row.update(kind="link", target=target)
        elif getattr(info, "st_file_attributes", 0) & 0x400:
            raise SigningError("artifact-reparse-point")
        elif stat.S_ISDIR(info.st_mode):
            row.update(kind="directory")
        elif stat.S_ISREG(info.st_mode):
            # Signing must not mutate an outside hard-linked copy of a binary.
            if info.st_nlink != 1:
                raise SigningError("hard-linked-signing-input")
            sha = hashlib.sha256()
            with path.open("rb") as source:
                count = 0
                while data := source.read(65536):
                    count += len(data)
                    if count > info.st_size:
                        raise SigningError("artifact-changed")
                    sha.update(data)
            after = path.lstat()
            if count != info.st_size or (
                info.st_ino,
                info.st_size,
                info.st_mtime_ns,
                info.st_mode,
            ) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode):
                raise SigningError("artifact-changed")
            row.update(kind="file", bytes=count, sha256=sha.hexdigest())
        else:
            raise SigningError("unsupported-artifact-member")
        result[name] = row
    return {
        "sha256": digest(result),
        "logicalBytes": sum(r.get("bytes", 0) for r in result.values()),
        "members": len(result),
    }
