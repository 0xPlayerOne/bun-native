//! Bounded persistent profile ownership, retained through CEF shutdown.
//! A root has one kernel lock and at most 128 distinct profile leases. Disposed
//! profiles reuse their existing lock on reopening; no stale lock is deleted.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

#[path = "session_credentials.rs"]
pub(crate) mod credentials;

#[path = "session_reset.rs"]
pub(crate) mod reset;

const ROOT_MARKER: &str = ".bunly-session-root.json";
const ROOT_LOCK: &str = ".bunly-session-root.lock";
const PROFILE_MARKER: &str = ".bunly-profile.json";
const PROFILE_LOCK: &str = ".bunly-profile.lock";
const MARKER_LIMIT: u64 = 4096;
const MAX_PROFILES: usize = 128;

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Marker {
    schema: u32,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    partition: Option<String>,
}

#[derive(Debug)]
struct OwnedProfile {
    file: File,
    active: bool,
}

#[derive(Debug)]
struct Ownership {
    root: Option<File>,
    profiles: BTreeMap<PathBuf, OwnedProfile>,
}

#[derive(Clone, Debug)]
pub struct ProfileRoot {
    path: PathBuf,
    ownership: Arc<Mutex<Ownership>>,
}

pub struct ProfileLease {
    ownership: Arc<Mutex<Ownership>>,
    pub path: PathBuf,
}

impl Drop for ProfileLease {
    fn drop(&mut self) {
        if let Ok(mut ownership) = self.ownership.lock() {
            if let Some(profile) = ownership.profiles.get_mut(&self.path) {
                profile.active = false;
            }
        }
    }
}

impl ProfileRoot {
    pub fn open(path: &Path) -> Result<Self, String> {
        validate_absolute(path, "Persistent profile root")?;
        reject_existing_symlink_components(path)?;
        create_private_dir(path)?;
        let canonical = normalized_canonical(path)?;
        if canonical != path {
            return Err(
                "Persistent profile root must already be normalized and contain no symbolic links"
                    .into(),
            );
        }
        validate_private_dir(&canonical, "Persistent profile root")?;
        if !canonical.join(ROOT_MARKER).exists() {
            for entry in fs::read_dir(&canonical)
                .map_err(|error| error.to_string())?
                .take(2)
            {
                if entry.map_err(|error| error.to_string())?.file_name() != ROOT_LOCK {
                    return Err("Refusing nonempty persistent root without a Bunly marker".into());
                }
            }
        }
        let root_file = open_owned_lock(&canonical.join(ROOT_LOCK))?;
        lock_exclusive(&root_file).map_err(|_| {
            "Persistent profile root is already in use or cannot be locked".to_string()
        })?;
        ensure_marker(
            &canonical,
            ROOT_MARKER,
            &Marker {
                schema: 1,
                kind: "bunly-session-root".into(),
                partition: None,
            },
            true,
        )?;
        Ok(Self {
            path: canonical,
            ownership: Arc::new(Mutex::new(Ownership {
                root: Some(root_file),
                profiles: BTreeMap::new(),
            })),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn acquire(&self, requested_root: &str, partition: &str) -> Result<ProfileLease, String> {
        if !valid_partition(partition) {
            return Err("Invalid persistent session partition".into());
        }
        let requested = Path::new(requested_root);
        validate_absolute(requested, "Persistent session root")?;
        if requested != self.path {
            return Err(
                "Persistent session root does not match the configured native profile root".into(),
            );
        }
        reject_existing_symlink_components(&self.path)?;
        validate_private_dir(&self.path, "Persistent profile root")?;
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| "Profile ownership unavailable")?;
        let root_file = ownership
            .root
            .as_ref()
            .ok_or("Persistent profile owner is closed")?;
        verify_owned_file(&self.path.join(ROOT_LOCK), root_file)?;
        // ChromeBrowserContext requires an immediate child of root_cache_path.
        // Hash the logical partition so case-insensitive filesystems cannot alias
        // distinct names or interpret a Windows device/reserved path component.
        if reset::pending(&self.path, partition)? {
            return Err("Persistent session has an interrupted offline reset; complete that reset before opening".into());
        }
        let profile = self.path.join(profile_directory(partition));
        if let Some(existing) = ownership.profiles.get_mut(&profile) {
            if existing.active {
                return Err("Persistent session partition already has a native owner".into());
            }
            validate_private_dir(&profile, "Persistent profile")?;
            reject_existing_symlink_components(&profile)?;
            verify_owned_file(&profile.join(PROFILE_LOCK), &existing.file)?;
            ensure_marker(
                &profile,
                PROFILE_MARKER,
                &Marker {
                    schema: 1,
                    kind: "bunly-profile".into(),
                    partition: Some(partition.into()),
                },
                false,
            )?;
            existing.active = true;
            return Ok(ProfileLease {
                ownership: self.ownership.clone(),
                path: profile,
            });
        }
        if ownership.profiles.len() >= MAX_PROFILES {
            return Err("Persistent profile lifetime capacity exceeded".into());
        }
        reject_existing_symlink_components(&profile)?;
        create_private_dir(&profile)?;
        let canonical = normalized_canonical(&profile)?;
        if canonical != profile || canonical.parent() != Some(self.path.as_path()) {
            return Err("Persistent profile must be normalized and contained by its root".into());
        }
        validate_private_dir(&canonical, "Persistent profile")?;
        ensure_marker(
            &canonical,
            PROFILE_MARKER,
            &Marker {
                schema: 1,
                kind: "bunly-profile".into(),
                partition: Some(partition.into()),
            },
            false,
        )?;
        let file = open_owned_lock(&canonical.join(PROFILE_LOCK))?;
        lock_exclusive(&file)
            .map_err(|_| "Persistent profile is already in use or cannot be locked".to_string())?;
        ownership
            .profiles
            .insert(canonical.clone(), OwnedProfile { file, active: true });
        Ok(ProfileLease {
            ownership: self.ownership.clone(),
            path: canonical,
        })
    }

    fn release_after_shutdown(&self) -> Result<(), String> {
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| "Profile ownership unavailable")?;
        if ownership.profiles.values().any(|profile| profile.active) {
            return Err(
                "Persistent profile still has an active native owner after shutdown".into(),
            );
        }
        ownership.profiles.clear();
        ownership.root.take();
        Ok(())
    }
}

pub fn retire(lease: ProfileLease) {
    drop(lease);
}

/// No lock is released here until the caller has completed CefShutdown.
pub fn release_after_cef_shutdown() -> Result<(), String> {
    if let Some(root) = crate::PATHS
        .get()
        .and_then(|paths| paths.profile_root.as_ref())
    {
        root.release_after_shutdown()?;
    }
    Ok(())
}

fn normalized_canonical(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Cannot resolve persistent profile: {error}"))?;
    cef_compatible_path(&canonical)
}

/// Preserve the canonical directory while adapting its spelling for CEF.
/// Windows canonicalization adds a verbatim prefix, but Chromium's LevelDB
/// appends forward-slash filenames. Win32 does not translate those separators
/// in verbatim paths. Native filesystem ownership keeps its original path.
pub(super) fn cef_compatible_path(canonical: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !canonical.is_absolute()
            || canonical
                .components()
                .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err("CEF cache path must be an absolute normalized path".into());
        }
        let mut parts = canonical.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            if let Prefix::VerbatimDisk(drive) = prefix.kind() {
                let mut normalized = PathBuf::from(format!("{}:\\", char::from(drive)));
                for part in parts {
                    if !matches!(part, Component::RootDir) {
                        normalized.push(part.as_os_str());
                    }
                }
                validate_absolute(&normalized, "CEF cache path")?;
                return Ok(normalized);
            }
        }
        validate_absolute(canonical, "CEF cache path")?;
    }
    Ok(canonical.to_path_buf())
}

fn open_owned_lock(path: &Path) -> Result<File, String> {
    if let Ok(info) = path.symlink_metadata() {
        if !info.is_file() || info.file_type().is_symlink() || info.len() != 0 {
            return Err("Persistent profile lock must be an empty regular file".into());
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Cannot open persistent profile lock: {error}"))?;
    verify_owned_file(path, &file)?;
    Ok(file)
}

fn verify_owned_file(path: &Path, file: &File) -> Result<(), String> {
    let opened = file.metadata().map_err(|error| error.to_string())?;
    let named = path.symlink_metadata().map_err(|error| error.to_string())?;
    if !opened.is_file()
        || !named.is_file()
        || named.file_type().is_symlink()
        || opened.len() != 0
        || named.len() != 0
    {
        return Err("Persistent profile lock identity is invalid".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.dev() != named.dev()
            || opened.ino() != named.ino()
            || opened.nlink() != 1
            || opened.uid() != unsafe { libc::geteuid() }
            || opened.mode() & 0o077 != 0
        {
            return Err("Persistent profile lock was replaced or is not privately owned".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if named.file_attributes() & 0x400 != 0 {
            return Err("Persistent profile reparse point denied".into());
        }
    }
    Ok(())
}

/// CEF156 CacheStorage adds 210 UTF-16 units below our root for the selected
/// SHA-256 profile, origin hash, cache UUID and index. Do not assume every CEF
/// component opts into extended Windows paths merely because Rust can open them.
/// Offline maintenance still accepts longer existing roots so callers can recover.
pub fn validate_cef_profile_path(root: &Path) -> Result<(), String> {
    #[cfg(windows)]
    use std::os::windows::ffi::OsStrExt;
    #[cfg(windows)]
    if !windows_root_within_storage_budget(root.as_os_str().encode_wide().count()) {
        return Err("Windows persistent profile root is too long for the pinned CEF storage layout; use a root of at most 48 UTF-16 units".into());
    }
    #[cfg(not(windows))]
    let _ = root;
    Ok(())
}
#[cfg(any(windows, test))]
fn windows_root_within_storage_budget(units: usize) -> bool {
    units <= 48
}

fn profile_directory(partition: &str) -> String {
    format!("bunly-profile-{:x}", Sha256::digest(partition.as_bytes()))
}

fn valid_partition(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && b"._-".contains(&byte))
        })
}

fn validate_absolute(path: &Path, label: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
        {
            return Err(format!(
                "{label} must use a local absolute disk path, not UNC or a device namespace"
            ));
        }
        for component in path.components() {
            if let Component::Normal(name) = component {
                let name = name.to_str().ok_or("Profile path must use valid Unicode")?;
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.len() == 4
                        && matches!(stem.as_bytes()[3], b'1'..=b'9'));
                if name.ends_with(['.', ' '])
                    || name.chars().any(|c| c == ':' || c.is_control())
                    || reserved
                {
                    return Err(format!(
                        "{label} contains a reserved or ambiguous Windows path component"
                    ));
                }
            }
        }
    }
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!("{label} must be an absolute normalized path"));
    }
    Ok(())
}

fn reject_existing_symlink_components(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match current.symlink_metadata() {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Persistent profile root contains a symbolic link".into());
            }
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("Persistent profile root contains a reparse point".into());
                    }
                }
                let _ = metadata;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot inspect persistent profile root: {error}")),
        }
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|error| format!("Cannot create private profile directory: {error}"))
}

fn validate_private_dir(path: &Path, label: &str) -> Result<(), String> {
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("Cannot inspect {label}: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} must be a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(format!(
                "{label} must be owned by the current user with private permissions"
            ));
        }
    }
    Ok(())
}

fn ensure_marker(
    directory: &Path,
    name: &str,
    expected: &Marker,
    allow_empty_root: bool,
) -> Result<(), String> {
    let marker = directory.join(name);
    match marker.symlink_metadata() {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MARKER_LIMIT
            {
                return Err("Persistent profile marker is not a bounded regular file".into());
            }
            let mut bytes = Vec::new();
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            options
                .open(&marker)
                .and_then(|file| file.take(MARKER_LIMIT + 1).read_to_end(&mut bytes))
                .map_err(|error| format!("Cannot read persistent profile marker: {error}"))?;
            let actual: Marker = serde_json::from_slice(&bytes)
                .map_err(|_| "Persistent profile marker is corrupt".to_string())?;
            if &actual != expected {
                return Err(
                    "Persistent profile marker does not match the requested session".into(),
                );
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot inspect persistent profile marker: {error}")),
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Cannot inspect persistent profile directory: {error}"))?
        .take(2)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot inspect persistent profile directory: {error}"))?;
    let unknown = entries
        .iter()
        .any(|entry| !allow_empty_root || entry.file_name() != ROOT_LOCK);
    if unknown && !allow_empty_root {
        return Err("Refusing unrecognized or interrupted persistent profile".into());
    }
    if allow_empty_root && unknown {
        return Err("Refusing nonempty persistent root without a Bunly marker".into());
    }
    let bytes = serde_json::to_vec(expected).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&marker)
        .map_err(|error| format!("Cannot create persistent profile marker: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot commit persistent profile marker: {error}"))
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn lock_exclusive(file: &File) -> std::io::Result<()> {
    use std::{mem::zeroed, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{Foundation::ERROR_LOCK_VIOLATION, Storage::FileSystem::*};
    let mut overlapped = unsafe { zeroed() };
    let ok = unsafe {
        LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if ok != 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
            Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, error))
        } else {
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn temporary(name: &str) -> PathBuf {
        normalized_canonical(&std::env::temp_dir())
            .unwrap()
            .join(format!(
                "bunly-session-test-{}-{}-{name}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
    }

    #[test]
    fn windows_storage_path_budget_retains_space_for_native_nested_stores() {
        let suffix = format!(
            "/bunly-profile-{}/Service Worker/CacheStorage/{}/{}/index-dir/the-real-index",
            "a".repeat(64),
            "b".repeat(40),
            "c".repeat(36)
        );
        assert_eq!(suffix.encode_utf16().count(), 210);
        assert!(windows_root_within_storage_budget(48));
        assert!(48 + suffix.encode_utf16().count() < 260);
        assert!(!windows_root_within_storage_budget(49));
        assert!(!windows_root_within_storage_budget(usize::MAX));
    }

    #[test]
    fn persistent_profiles_are_contained_marked_and_kernel_locked() {
        let path = temporary("lock");
        let root = ProfileRoot::open(&path).unwrap();
        let lease = root.acquire(path.to_str().unwrap(), "primary").unwrap();
        assert_eq!(lease.path.parent(), Some(path.as_path()));
        assert_ne!(profile_directory("Primary"), profile_directory("primary"));
        assert!(profile_directory("CON").starts_with("bunly-profile-"));
        assert!(root.acquire(path.to_str().unwrap(), "primary").is_err());
        drop(lease);
        let second = root.acquire(path.to_str().unwrap(), "primary").unwrap();
        assert_eq!(root.ownership.lock().unwrap().profiles.len(), 1);
        assert!(ProfileRoot::open(&path).is_err());
        drop(second);
        root.release_after_shutdown().unwrap();
        drop(root);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn traversal_symlinks_and_corrupt_or_unknown_profiles_fail_closed() {
        let traversal = temporary("traversal").join("..").join("escape");
        assert!(ProfileRoot::open(&traversal).is_err());

        let path = temporary("corrupt");
        let root = ProfileRoot::open(&path).unwrap();
        let profile = path.join(profile_directory("broken"));
        create_private_dir(&profile).unwrap();
        fs::write(profile.join("unknown"), b"data").unwrap();
        assert!(root.acquire(path.to_str().unwrap(), "broken").is_err());

        let profile = path.join(profile_directory("corrupt"));
        create_private_dir(&profile).unwrap();
        fs::write(profile.join(PROFILE_MARKER), b"{").unwrap();
        assert!(root.acquire(path.to_str().unwrap(), "corrupt").is_err());
        drop(root);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn repeated_profiles_reuse_a_bounded_lifetime_registry() {
        let path = temporary("bounded");
        let root = ProfileRoot::open(&path).unwrap();
        for _ in 0..256 {
            drop(root.acquire(path.to_str().unwrap(), "same").unwrap());
        }
        assert_eq!(root.ownership.lock().unwrap().profiles.len(), 1);
        for i in 1..MAX_PROFILES {
            drop(
                root.acquire(path.to_str().unwrap(), &format!("p{i}"))
                    .unwrap(),
            );
        }
        assert_eq!(root.ownership.lock().unwrap().profiles.len(), MAX_PROFILES);
        assert!(
            matches!(root.acquire(path.to_str().unwrap(), "overflow"), Err(message) if message.contains("capacity"))
        );
        let lease = root.acquire(path.to_str().unwrap(), "same").unwrap();
        assert!(root.release_after_shutdown().is_err());
        drop(lease);
        root.release_after_shutdown().unwrap();
        assert!(root.acquire(path.to_str().unwrap(), "same").is_err());
        let next = ProfileRoot::open(&path).unwrap();
        drop(next);
        drop(root);
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cef_paths_normalize_drive_prefixes_without_admitting_other_namespaces() {
        for (canonical, expected) in [
            (r"\\?\C:\Private é\Profile", r"C:\Private é\Profile"),
            (r"C:\Private é\Profile", r"C:\Private é\Profile"),
            (r"\\?\D:\", r"D:\"),
        ] {
            assert_eq!(
                cef_compatible_path(Path::new(canonical)).unwrap(),
                Path::new(expected)
            );
        }
        for denied in [
            r"\\server\share\profile",
            r"\\?\UNC\server\share\profile",
            r"\\.\pipe\profile",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\profile",
            r"\\?\C:\profile.\child",
            r"\\?\C:\profile \child",
            r"\\?\C:\CON\child",
            r"\\?\C:\profile:stream",
            r"\\?\C:\profile\..\other",
            r"C:relative",
        ] {
            assert!(cef_compatible_path(Path::new(denied)).is_err(), "{denied}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn cef_cache_path_allows_leveldb_slash_names_with_the_same_kernel_directory() {
        use std::ffi::OsStr;
        use std::os::windows::{
            ffi::OsStrExt,
            io::{FromRawHandle, OwnedHandle},
        };
        use windows_sys::Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{
                CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
            },
        };

        fn open_leveldb_lock(directory: &Path) -> std::io::Result<OwnedHandle> {
            // Match the pinned LevelDB's string append and Chromium's direct
            // CreateFile call, without Rust filesystem path adaptation.
            let mut name = directory.as_os_str().to_os_string();
            name.push(OsStr::new("/LOCK"));
            let wide: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_ALWAYS,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
            }
        }

        struct Temporary(PathBuf);
        impl Drop for Temporary {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let directory = Temporary(temporary("cef-cache-é"));
        create_private_dir(&directory.0).unwrap();
        let canonical = fs::canonicalize(&directory.0).unwrap();
        assert!(matches!(
            canonical.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));
        assert!(open_leveldb_lock(&canonical).is_err());
        let cef_path = cef_compatible_path(&canonical).unwrap();
        assert_eq!(fs::canonicalize(&cef_path).unwrap(), canonical);
        let lock = open_leveldb_lock(&cef_path).unwrap();
        assert!(canonical.join("LOCK").is_file());
        drop(lock);
    }

    #[cfg(windows)]
    #[test]
    fn windows_namespaces_and_aliases_fail_before_filesystem_access() {
        for value in [
            r"\\server\share\profile",
            r"\\?\C:\profile",
            r"\\.\pipe\profile",
            r"C:\profile:stream",
            r"C:\profile.\child",
            r"C:\profile \child",
            r"C:\CON\child",
            r"C:\COM1.txt\child",
            r"C:relative",
        ] {
            assert!(
                validate_absolute(Path::new(value), "Test root").is_err(),
                "{value}"
            );
        }
        assert!(validate_absolute(Path::new(r"C:\Private é\Profile"), "Test root").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_root_is_rejected() {
        use std::os::unix::fs::symlink;
        let target = temporary("target");
        let link = temporary("link");
        create_private_dir(&target).unwrap();
        symlink(&target, &link).unwrap();
        assert!(ProfileRoot::open(&link).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(target).unwrap();
    }
}
