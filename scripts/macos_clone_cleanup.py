"""Observe Bunly's exact Chromium post-exit clone cleanup; never delete clone storage.

Only a proven child of the launched root, its unchanged private helper, and a
clone hard-linked to that root can receive the separate three-second window.
Ordinary descendants keep their existing 500 ms policy. This is contributor
accounting, not a renderer permission or a same-user tamper security boundary.
"""

import hashlib
import itertools
import os
import plistlib
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import psutil
from macos_process_identity import MAX_PID_CANDIDATES, MacProcessIds

ROLE = "code-sign-clone-cleanup"
POST_EXIT_SECONDS = 3.0
MAX_CLONES = 256
MAX_HELPERS = 8
SUFFIX_PATTERN = r"[A-Za-z0-9._-]{6}"
MAX_EXECUTABLE_BYTES = 64 * 1024**2


def file_stamp(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("untrusted-helper-file")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def private_directory(path):
    info = Path(path).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("untrusted-clone-directory")
    return (info.st_dev, info.st_ino)


def executable_digest(path, expected=None):
    """Hash a bounded, unchanged regular file without following a substituted link."""
    before = file_stamp(path)
    if expected is not None and before != expected:
        raise ValueError("executable-changed")
    if before[2] > MAX_EXECUTABLE_BYTES:
        raise ValueError("executable-too-large")
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != before[:2]:
            raise ValueError("executable-replaced-during-open")
        total = 0
        while chunk := stream.read(65536):
            total += len(chunk)
            if total > MAX_EXECUTABLE_BYTES or total > before[2]:
                raise ValueError("executable-grew-during-verification")
            digest.update(chunk)
    if total != before[2] or file_stamp(path) != before:
        raise ValueError("executable-changed-during-verification")
    return before, digest.hexdigest()


def cleanup_suffix(args):
    if len(args) != 3 or args[1] != "--type=" + ROLE:
        return None
    match = re.fullmatch(r"--unique-temp-dir-suffix=(" + SUFFIX_PATTERN + r")", args[2])
    return match[1] if match else None


@dataclass(frozen=True)
class Clone:
    path: Path
    identity: tuple


class CloneCleanup:
    def __init__(self, app, helper, namespace, kernel=None):
        # Capture provenance before Popen, then bind the observed process. A
        # replacement during launch must not become the trusted baseline.
        self.root_pid = None
        self.root_birth = None
        self.kernel = kernel
        self.root_kernel = None
        self.app = Path(app)
        self.main = self.app / "Contents/MacOS/bunly_host"
        self.main_stamp, self.main_hash = executable_digest(self.main)
        self.main_identity = self.main_stamp[:2]
        self.helper = Path(helper)
        self.helper_stamp, self.helper_hash = executable_digest(self.helper)
        self.namespace = Path(namespace)
        self.namespace_identity = None
        self.prelaunch_entries = {}
        self.clones = {}
        self.ancestry = set()
        self.helpers = {}
        self.helper_kernels = {}
        self.ownership = {}
        self.recovery_attempted = False
        self.recovery_candidates = 0
        self.invalid = False
        # Another launch of this exact app may have left a clone with the same
        # main inode. Record the bounded namespace before Popen, not on the
        # first sample after launch, so that it cannot become this run's clone.
        try:
            for path in self.namespace_entries():
                try:
                    info = path.lstat()
                    identity = (info.st_dev, info.st_ino)
                except FileNotFoundError:
                    identity = None
                # Exclude the name even if another cleanup removed it during
                # the snapshot. Reusing an old suffix never grants ownership.
                self.prelaunch_entries[path.name] = identity
        except FileNotFoundError:
            if self.namespace_identity is not None:
                self.invalid = True
        except (OSError, ValueError):
            self.invalid = True

    def bind(self, root):
        if root is None:
            return
        try:
            proc = psutil.Process(root.pid)
            birth = proc.create_time()
            if (
                birth != root.create_time()
                or Path(proc.exe()) != self.main
                or proc.uids().real != os.getuid()
            ):
                raise ValueError("launched-host-mismatch")
            kernel = self.kernel.identity(root.pid) if self.kernel is not None else None
            # Chromium legitimately changes the main inode's ctime by linking
            # the clone. Content and the remaining identity fields must match.
            stamp, digest = executable_digest(self.main)
            if stamp[:4] != self.main_stamp[:4] or digest != self.main_hash:
                raise ValueError("launched-host-substituted")
            self.verify_helper()
            if psutil.Process(root.pid).create_time() != birth:
                raise ValueError("launched-host-pid-reused")
            if kernel is not None and self.kernel.identity(root.pid) != kernel:
                raise ValueError("launched-host-kernel-identity-changed")
            self.root_pid, self.root_birth = root.pid, birth
            self.root_kernel = kernel
        except psutil.NoSuchProcess:
            return  # A startup rejection may finish before the first sample.
        except (psutil.Error, OSError, ValueError):
            self.invalid = True

    def verify_helper(self):
        _, digest = executable_digest(self.helper, self.helper_stamp)
        if digest != self.helper_hash:
            raise ValueError("helper-content-changed")

    def namespace_entries(self):
        namespace_identity = private_directory(self.namespace)
        if self.namespace_identity not in (None, namespace_identity):
            raise ValueError("clone-namespace-substituted")
        self.namespace_identity = namespace_identity
        with os.scandir(self.namespace) as entries:
            paths = [Path(entry.path) for entry in itertools.islice(entries, MAX_CLONES + 1)]
        if len(paths) > MAX_CLONES:
            raise ValueError("clone-namespace-overfull")
        if private_directory(self.namespace) != namespace_identity:
            raise ValueError("clone-namespace-substituted-during-scan")
        return paths

    def discover_clones(self):
        # One namespace belonging to this fixture, never another browser's storage.
        if self.root_pid is None or self.invalid:
            return
        try:
            for path in self.namespace_entries():
                if path.name in self.prelaunch_entries or not re.fullmatch(
                    r"code_sign_clone\." + SUFFIX_PATTERN, path.name
                ):
                    continue
                try:
                    identity = private_directory(path)
                except FileNotFoundError:
                    continue
                suffix = path.name[len("code_sign_clone.") :]
                if suffix in self.clones:
                    if identity != self.clones[suffix].identity:
                        raise ValueError("tracked-clone-directory-substituted")
                    continue
                for name in (self.app.name, self.app.name + ".bundle"):
                    cloned = path / name / "Contents/MacOS/bunly_host"
                    try:
                        # No symlink component can establish provenance.
                        if any(
                            p.is_symlink()
                            for p in (
                                path / name,
                                cloned.parent.parent,
                                cloned.parent,
                                cloned,
                            )
                        ):
                            continue
                        matching = file_stamp(cloned)[:2] == self.main_identity
                    except (OSError, ValueError):
                        continue
                    if matching:
                        if len(self.clones) >= MAX_CLONES:
                            raise ValueError("tracked-clone-inventory-overfull")
                        self.clones[suffix] = Clone(path, identity)
                        break
        except FileNotFoundError:
            # An absent namespace before it was ever observed is optional;
            # disappearance of a bound namespace cannot prove any completion.
            if self.namespace_identity is not None:
                self.invalid = True
        except (OSError, ValueError):
            self.invalid = True

    def remember(self, identity, proc, retained=None):
        """Require observed live ancestry or the kernel's retained original parent."""
        try:
            proc = psutil.Process(identity[0])
            if self.invalid or proc.create_time() != identity[1]:
                return
            if retained is not None:
                if (
                    self.root_kernel is None
                    or retained.parent_unique_id != self.root_kernel.unique_id
                    or retained.unique_id == self.root_kernel.unique_id
                ):
                    return
            else:
                # Verify live root identity before admitting sampled ancestry.
                if (
                    proc.ppid() == self.root_pid
                    and psutil.Process(self.root_pid).create_time() == self.root_birth
                ):
                    self.ancestry.add(identity)
            if (retained is None and identity not in self.ancestry) or identity in self.helpers:
                return
            args = proc.cmdline()
            suffix = cleanup_suffix(args)
            if suffix not in self.clones or not suffix:
                return
            if (
                Path(proc.exe()) != self.helper
                or Path(args[0]) != self.helper
                or proc.uids().real != os.getuid()
                or file_stamp(self.helper) != self.helper_stamp
            ):
                return
            if len(self.helpers) >= MAX_HELPERS:
                self.invalid = True
                return
            kernel = retained
            if kernel is not None and (
                self.kernel.identity(identity[0]) != kernel
                or psutil.Process(identity[0]).create_time() != identity[1]
            ):
                return
            self.helpers[identity] = suffix
            self.helper_kernels[identity] = kernel
            self.ownership[identity] = (
                "retained-kernel-parent-and-matching-clone-inode"
                if kernel is not None
                else "observed-root-child-and-matching-clone-inode"
            )
        except (psutil.Error, OSError, ValueError):
            return

    def recover_after_exit(self):
        """One bounded scan closes the last-sample/reparenting race, fail closed."""
        if (
            self.recovery_attempted
            or self.invalid
            or self.root_kernel is None
            or not self.clones
            or self.helpers
        ):
            return []
        self.recovery_attempted = True
        recovered = []
        helper_checks = 0
        try:
            pids = self.kernel.same_uid_pids()
            if len(pids) > MAX_PID_CANDIDATES:
                raise ValueError("kernel-process-inventory-overfull")
            self.recovery_candidates = len(pids)
            for pid in pids:
                kernel = self.kernel.identity(pid)
                if kernel is None or kernel.parent_unique_id != self.root_kernel.unique_id:
                    continue
                try:
                    proc = psutil.Process(pid)
                    identity = (pid, proc.create_time())
                    # Only exact helper executables become candidates for the
                    # stricter argv/hash/clone proof in remember().
                    if proc.uids().real != os.getuid() or Path(proc.exe()) != self.helper:
                        continue
                    if helper_checks >= MAX_HELPERS:
                        self.invalid = True
                        break
                    helper_checks += 1
                    self.remember(identity, proc, retained=kernel)
                    if identity in self.helpers:
                        recovered.append((identity, proc))
                    if self.invalid:
                        break
                except (psutil.Error, OSError, ValueError):
                    continue
        except (OSError, ValueError):
            self.invalid = True
        return recovered

    def grant(self, identity):
        """Rehash before granting extra time; a stat comparison alone is insufficient."""
        if self.invalid or identity not in self.helpers:
            return False
        try:
            self.verify_helper()
            return self.state(identity) in ("running", "exited")
        except (OSError, ValueError):
            self.invalid = True
            return False

    def state(self, identity):
        if identity not in self.helpers:
            return "unqualified"
        try:
            if file_stamp(self.helper) != self.helper_stamp:
                self.invalid = True
                return "invalid"
            proc = psutil.Process(identity[0])
            if proc.create_time() != identity[1]:
                self.invalid = True
                return "invalid"
            kernel = self.helper_kernels.get(identity)
            if kernel is not None and self.kernel.identity(identity[0]) != kernel:
                self.invalid = True
                return "invalid"
            if proc.status() == psutil.STATUS_ZOMBIE:
                return "exited"
            if Path(proc.exe()) != self.helper or proc.uids().real != os.getuid():
                self.invalid = True
                return "invalid"
            if cleanup_suffix(proc.cmdline()) != self.helpers[identity]:
                self.invalid = True
                return "invalid"
            return "running"
        except psutil.NoSuchProcess:
            return "exited"
        except (psutil.Error, OSError, ValueError):
            self.invalid = True
            return "invalid"

    def clone_removed(self, suffix):
        clone = self.clones[suffix]
        try:
            if private_directory(self.namespace) != self.namespace_identity:
                return None
            # A substituted directory is never interpreted as successful cleanup.
            return False if private_directory(clone.path) == clone.identity else None
        except FileNotFoundError:
            # A missing parent is not proof that this exact clone was removed.
            try:
                return private_directory(self.namespace) == self.namespace_identity
            except (OSError, ValueError):
                return None
        except (OSError, ValueError):
            return None

    def complete(self, identity):
        return (
            self.state(identity) == "exited" and self.clone_removed(self.helpers[identity]) is True
        )

    def report(self, elapsed_ms):
        rows = []
        for identity, suffix in self.helpers.items():
            state = self.state(identity)
            removed = self.clone_removed(suffix)
            rows.append(
                {
                    "pid": identity[0],
                    "creationTime": identity[1],
                    "role": ROLE,
                    "executableSha256": self.helper_hash,
                    "ownership": self.ownership[identity],
                    **(
                        {
                            "kernelIdentity": {
                                "rootUniqueId": str(self.root_kernel.unique_id),
                                "uniqueId": str(self.helper_kernels[identity].unique_id),
                                "parentUniqueId": str(
                                    self.helper_kernels[identity].parent_unique_id
                                ),
                            }
                        }
                        if self.helper_kernels[identity] is not None
                        else {}
                    ),
                    "processExited": state == "exited",
                    "cloneRemoved": removed is True,
                    "completed": state == "exited" and removed is True,
                }
            )
        all_removed = all(self.clone_removed(suffix) is True for suffix in self.clones)
        passed = not self.invalid and all_removed and all(row["completed"] for row in rows)
        qualified = passed and bool(self.clones) and bool(rows)
        return {
            "schema": 1,
            "profile": "macos-verified-code-sign-clone-v1",
            "limitMs": 3000,
            "elapsedMs": elapsed_ms,
            "observedClones": len(self.clones),
            "cloneInventory": {
                "prelaunchEntries": len(self.prelaunch_entries),
                "entryLimit": MAX_CLONES,
                "scope": "new-names-after-prelaunch-snapshot",
            },
            "helpers": rows,
            "passed": passed,
            "qualified": qualified,
            "status": "completed" if qualified else "not-observed" if passed else "failed",
            "verification": "sampled identity and exact clone removal, not helper exit-code attestation",
            "recovery": {
                "attempted": self.recovery_attempted,
                "candidates": self.recovery_candidates,
                "candidateLimit": MAX_PID_CANDIDATES,
                "scanLimit": 1,
            },
        }


def for_command(command):
    if sys.platform != "darwin" or not command:
        return None
    try:
        main = Path(command[0])
        if (
            not main.is_absolute()
            or main != main.resolve(strict=True)
            or main.name != "bunly_host"
            or main.parent.name != "MacOS"
            or main.parent.parent.name != "Contents"
        ):
            return None
        app = main.parents[2]
        if app.suffix != ".app" or app.is_symlink():
            return None
        info = app / "Contents/Info.plist"
        if info.is_symlink() or info.stat().st_size > 65536:
            return None
        bundle = plistlib.loads(info.read_bytes()).get("CFBundleIdentifier")
        if bundle != "dev.bunly.fixture":
            return None
        helper = app / "Contents/Frameworks/bunly_host Helper.app/Contents/MacOS/bunly_host Helper"
        if any(
            path.is_symlink()
            for path in (helper, helper.parent, helper.parent.parent, helper.parents[2])
        ):
            return None
        temp = Path(
            subprocess.check_output(
                ["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], text=True, timeout=2
            ).strip()
        ).resolve(strict=True)
        if temp.name != "T" or not temp.is_relative_to("/private/var/folders"):
            return None
        namespace = temp.parent / "X" / (bundle + ".code_sign_clone")
        try:
            kernel = MacProcessIds()
        except (OSError, AttributeError):
            kernel = None
        return CloneCleanup(app, helper, namespace, kernel=kernel)
    except (
        psutil.Error,
        OSError,
        ValueError,
        subprocess.SubprocessError,
        plistlib.InvalidFileException,
    ):
        return None
