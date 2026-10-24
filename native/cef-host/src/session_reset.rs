//! Explicit offline whole-profile reset. No CEF object or backend is running.
//! A durable intent fences interrupted deletion; only the selected marked profile
//! can be quarantined and removed under the existing kernel-held root lock.
use super::*;

const RESET_KIND: &str = "bunly-profile-reset";
const ENTRY_LIMIT: usize = 65_536;
const PATH_BYTES_LIMIT: usize = 16 * 1024 * 1024;
const DEPTH_LIMIT: usize = 64;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    pub schema: u32,
    pub partition: String,
    pub offline: bool,
    pub storage_cleared: bool,
    pub cookies_cleared: bool,
    pub cache_cleared: bool,
    pub recovered_interruption: bool,
    /// Remaining profile inventory (including markers) at this invocation, not historical bytes from earlier attempts.
    pub remaining_entries_removed: usize,
    pub remaining_logical_bytes_removed: u64,
}

#[derive(Default)]
struct Inventory {
    entries: usize,
    path_bytes: usize,
    logical_bytes: u64,
}

fn names(partition: &str) -> (String, String) {
    let hash = format!("{:x}", Sha256::digest(partition.as_bytes()));
    (
        format!(".bunly-reset-{hash}.json"),
        format!("bunly-reset-{hash}"),
    )
}

fn exists(path: &Path) -> Result<bool, String> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Cannot inspect session reset state: {error}")),
    }
}

pub(super) fn pending(root: &Path, partition: &str) -> Result<bool, String> {
    let (intent, quarantine) = names(partition);
    Ok(exists(&root.join(intent))? || exists(&root.join(quarantine))?)
}

fn marker(partition: &str) -> Marker {
    Marker {
        schema: 1,
        kind: RESET_KIND.into(),
        partition: Some(partition.into()),
    }
}

fn required_marker(directory: &Path, name: &str, expected: &Marker) -> Result<(), String> {
    if !exists(&directory.join(name))? {
        return Err("Session reset refuses an unmarked profile or root".into());
    }
    reject_existing_symlink_components(&directory.join(name))?;
    ensure_marker(directory, name, expected, false)
}

fn write_intent(root: &Path, name: &str, partition: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(&marker(partition)).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(root.join(name))
        .map_err(|error| format!("Cannot create reset intent: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot commit reset intent: {error}"))?;
    sync_directory(root)
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Cannot sync session reset directory: {error}"))?;
    #[cfg(not(unix))]
    let _ = path; // Windows file sync + kernel locks; no power-loss atomicity claim.
    Ok(())
}

fn inspect_tree(
    path: &Path,
    relative: &Path,
    depth: usize,
    count: &mut Inventory,
) -> Result<(), String> {
    if depth > DEPTH_LIMIT {
        return Err("Session reset depth bound exceeded".into());
    }
    let info = path
        .symlink_metadata()
        .map_err(|error| format!("Cannot inspect reset entry: {error}"))?;
    if info.file_type().is_symlink() || !(info.is_dir() || info.is_file()) {
        return Err("Session reset refuses links or special files".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if info.uid() != unsafe { libc::geteuid() } || (info.is_file() && info.nlink() != 1) {
            return Err("Session reset refuses foreign or hard-linked files".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return Err("Session reset refuses reparse points".into());
        }
    }
    count.entries = count
        .entries
        .checked_add(1)
        .ok_or("Session reset entry count overflow")?;
    let length = relative.as_os_str().len();
    if length > 4096 {
        return Err("Session reset path bound exceeded".into());
    }
    count.path_bytes = count
        .path_bytes
        .checked_add(length)
        .ok_or("Session reset path count overflow")?;
    if count.entries > ENTRY_LIMIT || count.path_bytes > PATH_BYTES_LIMIT {
        return Err("Session reset inventory bound exceeded".into());
    }
    if info.is_file() {
        count.logical_bytes = count
            .logical_bytes
            .checked_add(info.len())
            .ok_or("Session reset byte count overflow")?;
        if count.logical_bytes > 9_007_199_254_740_991 {
            return Err("Session reset inventory exceeds exact result bounds".into());
        }
    } else {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            inspect_tree(
                &entry.path(),
                &relative.join(entry.file_name()),
                depth + 1,
                count,
            )?;
        }
    }
    Ok(())
}

pub fn execute(root: &Path, partition: &str) -> Result<ResetResult, String> {
    #[cfg(not(feature = "rpc-qualification"))]
    if std::env::var_os("BUNLY_RESET_FIXTURE_PAUSE").is_some() {
        return Err("Offline reset interruption fixture is not compiled".into());
    }
    execute_inner(root, partition, |stage| {
        #[cfg(feature = "rpc-qualification")]
        if std::env::var("BUNLY_RESET_FIXTURE_PAUSE").as_deref() == Ok("quarantined")
            && stage == "quarantined"
        {
            if root.file_name().and_then(|name| name.to_str()) != Some("bunly-reset-fixture-root") {
                return Err("Offline reset interruption requires the owned fixture root".into());
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut ready = options
                .open(root.join(".bunly-reset-fixture-ready"))
                .map_err(|error| error.to_string())?;
            ready
                .write_all(b"quarantined\n")
                .and_then(|_| ready.sync_all())
                .map_err(|error| error.to_string())?;
            // Deliberate bounded interruption control, never ordinary runtime behavior.
            std::thread::sleep(std::time::Duration::from_secs(10));
            return Err("Offline reset interruption fixture expired without cancellation".into());
        }
        let _ = stage;
        Ok(())
    })
}

fn execute_inner(
    root: &Path,
    partition: &str,
    mut checkpoint: impl FnMut(&str) -> Result<(), String>,
) -> Result<ResetResult, String> {
    if !valid_partition(partition) {
        return Err("Invalid persistent session partition".into());
    }
    if root.as_os_str().len() > 4096 || root.components().count() > 128 {
        return Err("Session reset root exceeds path bounds".into());
    }
    validate_absolute(root, "Persistent profile root")?;
    reject_existing_symlink_components(root)?;
    required_marker(
        root,
        ROOT_MARKER,
        &Marker {
            schema: 1,
            kind: "bunly-session-root".into(),
            partition: None,
        },
    )?;
    // This fails before any reset mutation while a cooperative host is alive.
    let owner = ProfileRoot::open(root)?;
    let ownership = owner
        .ownership
        .lock()
        .map_err(|_| "Profile ownership unavailable")?;
    let root_file = ownership.root.as_ref().ok_or("Profile owner is closed")?;
    verify_owned_file(&root.join(ROOT_LOCK), root_file)?;
    let profile = root.join(profile_directory(partition));
    let (intent_name, quarantine_name) = names(partition);
    let intent = root.join(&intent_name);
    let quarantine = root.join(&quarantine_name);
    let recovered = exists(&intent)?;
    let profile_present = exists(&profile)?;
    let quarantine_present = exists(&quarantine)?;
    if recovered {
        required_marker(root, &intent_name, &marker(partition))?;
    }
    if profile_present && quarantine_present {
        return Err("Session reset found conflicting profile and quarantine".into());
    }
    if quarantine_present && !recovered {
        return Err("Session reset refuses an unowned quarantine".into());
    }
    if !profile_present && !quarantine_present {
        if !recovered {
            return Err("Persistent session profile does not exist".into());
        }
        // A previous attempt removed the quarantine but exited before clearing intent.
        fs::remove_file(&intent).map_err(|error| error.to_string())?;
        sync_directory(root)?;
        return Ok(result(partition, true, Inventory::default()));
    }
    let selected = if quarantine_present {
        &quarantine
    } else {
        &profile
    };
    validate_private_dir(selected, "Selected persistent profile")?;
    reject_existing_symlink_components(selected)?;
    if !recovered || profile_present || exists(&selected.join(PROFILE_MARKER))? {
        required_marker(
            selected,
            PROFILE_MARKER,
            &Marker {
                schema: 1,
                kind: "bunly-profile".into(),
                partition: Some(partition.into()),
            },
        )?;
    }
    if recovered && quarantine_present && !exists(&selected.join(PROFILE_MARKER))? {
        // Our deletion order removes the marker only after every data child.
        // A markerless directory containing data cannot be inferred to be owned
        // merely from a matching quarantine name and must never be erased.
        for entry in fs::read_dir(selected)
            .map_err(|error| error.to_string())?
            .take(2)
        {
            if entry.map_err(|error| error.to_string())?.file_name() != PROFILE_LOCK {
                return Err("Session reset refuses unmarked quarantine data".into());
            }
        }
    }
    let profile_file = open_owned_lock(&selected.join(PROFILE_LOCK))?;
    lock_exclusive(&profile_file).map_err(|_| "Persistent profile is still in use")?;
    verify_owned_file(&selected.join(PROFILE_LOCK), &profile_file)?;
    let mut inventory = Inventory::default();
    inspect_tree(selected, Path::new(""), 0, &mut inventory)?;
    checkpoint("validated")?;
    if !recovered {
        write_intent(root, &intent_name, partition)?;
    }
    checkpoint("intent")?;
    if profile_present {
        fs::rename(&profile, &quarantine)
            .map_err(|error| format!("Cannot quarantine selected profile: {error}"))?;
        sync_directory(root)?;
    }
    checkpoint("quarantined")?;
    // Keep the marker and lock until all data children have gone. The durable
    // intent fences normal acquire throughout partial deletion and recovery.
    for entry in fs::read_dir(&quarantine).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if [PROFILE_MARKER, PROFILE_LOCK]
            .iter()
            .any(|name| entry.file_name() == *name)
        {
            continue;
        }
        let info = entry
            .path()
            .symlink_metadata()
            .map_err(|error| error.to_string())?;
        if info.file_type().is_symlink() {
            return Err("Profile changed during reset".into());
        }
        if info.is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        }
        .map_err(|error| {
            format!("Profile reset incomplete; retry the same offline reset: {error}")
        })?;
        checkpoint("entry-removed")?;
    }
    checkpoint("data-removed")?;
    // Root lock remains held; release only this profile's descriptor so Windows
    // can remove its lock file without deleting another writer's live handle.
    drop(profile_file);
    for name in [PROFILE_MARKER, PROFILE_LOCK] {
        let path = quarantine.join(name);
        if exists(&path)? {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        if name == PROFILE_MARKER {
            checkpoint("marker-removed")?;
        }
    }
    fs::remove_dir(&quarantine).map_err(|error| error.to_string())?;
    sync_directory(root)?;
    checkpoint("quarantine-removed")?;
    verify_owned_file(&root.join(ROOT_LOCK), root_file)?;
    fs::remove_file(&intent).map_err(|error| error.to_string())?;
    sync_directory(root)?;
    Ok(result(partition, recovered, inventory))
}

fn result(partition: &str, recovered: bool, inventory: Inventory) -> ResetResult {
    ResetResult {
        schema: 1,
        partition: partition.into(),
        offline: true,
        storage_cleared: true,
        cookies_cleared: true,
        cache_cleared: true,
        recovered_interruption: recovered,
        remaining_entries_removed: inventory.entries,
        remaining_logical_bytes_removed: inventory.logical_bytes,
    }
}

/// Refuse a malformed maintenance request, never fall through to starting an app.
pub fn command(arguments: &[String]) -> Result<Option<String>, String> {
    let requested = arguments.iter().any(|argument| {
        argument.starts_with("--bunly-reset-profile")
            || argument.starts_with("--bunly-confirm-profile-reset")
    });
    if !requested {
        return Ok(None);
    }
    if arguments.len() != 2 || arguments[1] != "--bunly-confirm-profile-reset" {
        return Err("Offline reset requires exactly --bunly-reset-profile=PARTITION --bunly-confirm-profile-reset".into());
    }
    let partition = arguments[0]
        .strip_prefix("--bunly-reset-profile=")
        .filter(|value| valid_partition(value))
        .ok_or("Invalid explicit session reset partition")?;
    Ok(Some(partition.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, PathBuf, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = super::super::tests::temporary(&format!("offline-reset-{sequence}"));
        assert!(!root.exists(), "test fixture identity collision");
        let owner = ProfileRoot::open(&root).unwrap();
        let a = owner.acquire(root.to_str().unwrap(), "A").unwrap();
        let b = owner.acquire(root.to_str().unwrap(), "B").unwrap();
        fs::create_dir(a.path.join("IndexedDB")).unwrap();
        fs::write(a.path.join("IndexedDB/data"), b"owned database").unwrap();
        fs::write(b.path.join("sentinel"), b"keep other partition").unwrap();
        let paths = (root, a.path.clone(), b.path.clone());
        drop(a);
        drop(b);
        owner.release_after_shutdown().unwrap();
        paths
    }
    #[test]
    fn explicit_offline_reset_deletes_only_the_selected_profile() {
        let (root, a, b) = setup();
        let r = execute(&root, "A").unwrap();
        assert!(r.storage_cleared && !r.recovered_interruption);
        assert!(!a.exists());
        assert_eq!(
            fs::read(b.join("sentinel")).unwrap(),
            b"keep other partition"
        );
        let owner = ProfileRoot::open(&root).unwrap();
        let fresh = owner.acquire(root.to_str().unwrap(), "A").unwrap();
        assert!(!fresh.path.join("IndexedDB").exists());
        drop(fresh);
        owner.release_after_shutdown().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn live_root_and_unknown_profiles_are_never_erased() {
        let (root, a, _) = setup();
        let owner = ProfileRoot::open(&root).unwrap();
        assert!(execute(&root, "A").is_err());
        assert!(a.join("IndexedDB/data").exists());
        owner.release_after_shutdown().unwrap();
        assert!(execute(&root, "absent").is_err());
        assert!(execute(&root, "../escape").is_err());
        fs::remove_file(a.join(PROFILE_MARKER)).unwrap();
        assert!(execute(&root, "A").is_err());
        assert!(a.join("IndexedDB/data").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_deletion_fences_reopen_and_resumes_without_touching_other_profiles() {
        for stage in [
            "intent",
            "quarantined",
            "entry-removed",
            "data-removed",
            "marker-removed",
            "quarantine-removed",
        ] {
            let (root, a, b) = setup();
            assert!(execute_inner(&root, "A", |current| if current == stage {
                Err("injected interruption".into())
            } else {
                Ok(())
            })
            .is_err());
            let owner = ProfileRoot::open(&root).unwrap();
            assert!(owner.acquire(root.to_str().unwrap(), "A").is_err());
            owner.release_after_shutdown().unwrap();
            let result = execute(&root, "A").unwrap();
            assert!(result.recovered_interruption, "{stage}");
            assert!(!a.exists());
            assert!(b.join("sentinel").exists());
            assert!(!pending(&root, "A").unwrap());
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn corrupt_or_unowned_recovery_state_fails_closed() {
        let (root, a, _) = setup();
        let (intent, quarantine) = names("A");
        fs::create_dir(root.join(&quarantine)).unwrap();
        assert!(execute(&root, "A").is_err());
        fs::remove_dir(root.join(quarantine)).unwrap();
        fs::write(root.join(&intent), b"{}").unwrap();
        assert!(execute(&root, "A").is_err());
        assert!(a.join("IndexedDB/data").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_reset_intent_cannot_authorize_unmarked_quarantine_data() {
        let (root, a, _) = setup();
        let (intent, quarantine) = names("A");
        write_intent(&root, &intent, "A").unwrap();
        fs::rename(&a, root.join(&quarantine)).unwrap();
        fs::remove_file(root.join(&quarantine).join(PROFILE_MARKER)).unwrap();
        assert!(execute(&root, "A").is_err());
        assert!(root.join(quarantine).join("IndexedDB/data").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_data_cannot_escape_or_be_deleted_by_reset() {
        let (root, a, b) = setup();
        std::os::unix::fs::symlink(b.join("sentinel"), a.join("escape")).unwrap();
        assert!(execute(&root, "A").is_err());
        assert!(a.join("IndexedDB/data").exists());
        assert!(b.join("sentinel").exists());
        fs::remove_file(a.join("escape")).unwrap();
        fs::hard_link(b.join("sentinel"), a.join("hard-link")).unwrap();
        assert!(execute(&root, "A").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inventory_depth_is_bounded_before_any_deletion() {
        let (root, a, _) = setup();
        let mut path = a.clone();
        for _ in 0..=DEPTH_LIMIT {
            path = path.join("d");
            fs::create_dir(&path).unwrap();
        }
        assert!(execute(&root, "A").is_err());
        assert!(!pending(&root, "A").unwrap());
        assert!(a.join("IndexedDB/data").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn command_requires_exact_opt_in_and_never_ignores_malformed_reset_flags() {
        assert_eq!(command(&[]).unwrap(), None);
        assert_eq!(
            command(&[
                "--bunly-reset-profile=primary".into(),
                "--bunly-confirm-profile-reset".into()
            ])
            .unwrap(),
            Some("primary".into())
        );
        for args in [
            vec!["--bunly-reset-profile=primary"],
            vec![
                "--bunly-reset-profile=../other",
                "--bunly-confirm-profile-reset",
            ],
            vec!["--bunly-confirm-profile-reset"],
            vec![
                "--bunly-reset-profile=primary",
                "--bunly-confirm-profile-reset",
                "--no-sandbox",
            ],
            vec!["--bunly-reset-profile", "--bunly-confirm-profile-reset"],
        ] {
            assert!(command(&args.into_iter().map(str::to_owned).collect::<Vec<_>>()).is_err());
        }
    }
}
