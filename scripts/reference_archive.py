"""Create/verify a portable reference-app archive, without extracting or executing it.

This is a separately timed packaging profile, not the framework's default installer.
Code signing, notarization, ACLs and extended attributes are not provided here.
"""

import argparse
import gzip
import hashlib
import json
import os
import stat
import tarfile
from pathlib import Path, PurePosixPath


def sha(stream, limit):
    digest = hashlib.sha256()
    count = 0
    while chunk := stream.read(min(65536, limit - count + 1)):
        count += len(chunk)
        if count > limit:
            raise ValueError("Archive/source size exceeded expected bound")
        digest.update(chunk)
    if count != limit:
        raise ValueError("Truncated archive/source file")
    return digest.hexdigest()


def inventory(source):
    source = Path(source).absolute()
    if source.is_symlink():
        raise ValueError("Source root must not be linked")
    # Canonicalize ancestor aliases (macOS /var -> /private/var) without
    # permitting a symlink as the artifact root itself.
    source = source.resolve(strict=True)
    paths = [source] + (sorted(source.rglob("*")) if source.is_dir() else [])
    if len(paths) > 100000:
        raise ValueError("Archive entry budget exceeded")
    result = {}
    for path in paths:
        rel = (
            PurePosixPath("BunlyReference") / path.relative_to(source)
            if path != source
            else PurePosixPath("BunlyReference")
        )
        info = path.lstat()
        value = {"mode": stat.S_IMODE(info.st_mode)}
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            if Path(target).is_absolute() or not path.resolve().is_relative_to(source):
                raise ValueError("Application link escapes its artifact")
            value.update(kind="link", target=target)
        elif stat.S_ISDIR(info.st_mode):
            value.update(kind="directory")
        elif stat.S_ISREG(info.st_mode):
            with path.open("rb") as file:
                digest = sha(file, info.st_size)
            after = path.stat()
            if (info.st_ino, info.st_size, info.st_mtime_ns) != (
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            ):
                raise ValueError("Source changed during hashing")
            value.update(kind="file", size=info.st_size, sha256=digest)
        else:
            raise ValueError("Unsupported source member")
        result[str(rel)] = value
    return result


def verify(source, filename):
    expected = inventory(source)
    seen = set()
    with tarfile.open(filename, "r:gz") as archive:
        for member in archive:
            name = member.name.rstrip("/")
            if name in seen or name not in expected:
                raise ValueError("Unexpected or duplicate archive member")
            seen.add(name)
            value = expected[name]
            if (
                member.mode != value["mode"]
                or member.uid
                or member.gid
                or member.uname
                or member.gname
            ):
                raise ValueError("Archive metadata mismatch")
            if value["kind"] == "file":
                if not member.isfile() or member.size != value["size"]:
                    raise ValueError("File header mismatch")
                stream = archive.extractfile(member)
                if stream is None or sha(stream, value["size"]) != value["sha256"]:
                    raise ValueError("Archived file content mismatch")
            elif value["kind"] == "directory":
                if not member.isdir():
                    raise ValueError("Expected directory member")
            elif not member.issym() or member.linkname != value["target"]:
                raise ValueError("Link mismatch")
    if seen != set(expected):
        raise ValueError("Incomplete archive")
    if inventory(source) != expected:
        raise ValueError("Source changed during verification")
    return len(seen)


def create(source, filename):
    source, filename = Path(source).absolute(), Path(filename).absolute()
    canonical_source = source.resolve(strict=True)
    canonical_output = filename.resolve()
    if canonical_source == canonical_output or (
        canonical_source.is_dir() and canonical_output.is_relative_to(canonical_source)
    ):
        raise ValueError("Archive output must be outside the source artifact")
    before = inventory(source)
    filename.parent.mkdir(parents=True, exist_ok=True)

    # Preserve required file modes and internal links, but omit personal owner names.
    def metadata(member):
        member.uid = member.gid = member.mtime = 0
        member.uname = member.gname = ""
        return member

    with (
        filename.open("xb") as output,
        gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed,
        tarfile.open(fileobj=compressed, mode="w", dereference=False) as archive,
    ):
        for name, value in before.items():
            parts = PurePosixPath(name).parts[1:]
            path = source.joinpath(*parts) if parts else source
            member = metadata(archive.gettarinfo(str(path), arcname=name))
            if value["kind"] == "file":
                # Store hard-linked regular files as full logical copies.
                # Do not rely on TarFile's internal inode cache behavior.
                member.type, member.linkname, member.size = tarfile.REGTYPE, "", value["size"]
                with path.open("rb") as file:
                    archive.addfile(member, file)
            else:
                archive.addfile(member)
    if inventory(source) != before:
        raise ValueError("Source changed during archive creation")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "verify"])
    parser.add_argument("source")
    parser.add_argument("archive")
    args = parser.parse_args()
    if args.action == "create":
        create(args.source, args.archive)
    else:
        count = verify(args.source, args.archive)
        stage, nonce = os.getenv("BUNLY_BENCH_STAGE"), os.getenv("BUNLY_BENCH_NONCE")
        if stage != "installer-compress" or nonce is None or len(nonce) != 48:
            raise SystemExit("Expected release-stage verifier context")
        print(
            json.dumps(
                {
                    "event": "benchmark-verification",
                    "stage": stage,
                    "nonce": nonce,
                    "passed": True,
                    "evidence": f"Verified all {count} archive members against the actual app; portable tar profile, not native installer acceptance",
                }
            )
        )
