//! Scoped staging and final placement. CEF accepts a pathname, not an OS handle;
//! never pass a user destination to it. Commit preserves the downloaded inode
//! (including platform security metadata) and cleanup is limited to owned files.
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[cfg(unix)]
#[path = "download_files_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "download_files_windows.rs"]
mod platform;

pub(crate) fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 128
        || !bytes[0].is_ascii_alphanumeric()
        || bytes
            .iter()
            .any(|byte| !(byte.is_ascii_alphanumeric() || b"._-".contains(byte)))
        || name.ends_with('.')
    {
        return false;
    }
    let base = name.split('.').next().unwrap().to_ascii_uppercase();
    !matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

/// No Drop cleanup: CEF may still own an open writer after a failed callback.
/// The caller explicitly settles this owner, or retains it until CefShutdown.
pub(crate) struct Staging {
    root_path: PathBuf,
    stage_name: String,
    name: String,
    replace: bool,
    root: platform::Directory,
    stage: platform::Directory,
    payload: Option<File>,
    placed: bool,
    removed: bool,
    started: bool,
}
impl Staging {
    pub fn prepare(root: &Path, name: &str, replace: bool) -> Result<Self, String> {
        if !valid_name(name) {
            return Err("INVALID_ARGUMENT: unsafe download filename".into());
        }
        let root_handle = platform::Directory::open_root(root)?;
        root_handle.validate_destination(name, replace)?;
        static SERIAL: AtomicU64 = AtomicU64::new(1);
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        if serial == u64::MAX {
            return Err("Download staging identity exhausted".into());
        }
        let stage_name = format!(".bunly-download-{}-{serial}", std::process::id());
        if root
            .join(&stage_name)
            .join("payload")
            .to_str()
            .is_none_or(|path| path.len() > 4096)
        {
            return Err("Download staging pathname exceeds its native bound".into());
        }
        // Exclusive creation is the ownership proof. Existing names are neither
        // reused nor recursively erased, including leftovers from an earlier run.
        let stage = root_handle.create_private_dir(&stage_name)?;
        Ok(Self {
            root_path: root.to_owned(),
            stage_name,
            name: name.to_owned(),
            replace,
            root: root_handle,
            stage,
            payload: None,
            placed: false,
            removed: false,
            started: false,
        })
    }
    pub fn path(&self) -> PathBuf {
        self.root_path.join(&self.stage_name).join("payload")
    }
    pub fn handle_count(&self) -> usize {
        self.root.handle_count() + self.stage.handle_count() + usize::from(self.payload.is_some())
    }
    pub fn verify(&self) -> Result<(), String> {
        self.root.verify_path(&self.root_path)?;
        self.root.verify_child(&self.stage_name, &self.stage)?;
        if let Some(file) = &self.payload {
            self.stage.verify_file("payload", file)?;
        }
        Ok(())
    }
    pub fn begin(&mut self) -> Result<(), String> {
        self.verify()?;
        if self.started || self.stage.open_file("payload")?.is_some() {
            return Err("Download staging target is not empty".into());
        }
        // Chromium creates a temporary file, then RenameAndUniquify moves it
        // here. A pre-created placeholder would force a different filename.
        self.started = true;
        Ok(())
    }
    fn capture(&mut self) -> Result<(), String> {
        if self.payload.is_none() && self.started {
            self.payload = self.stage.open_file("payload")?;
        }
        Ok(())
    }
    pub fn commit(&mut self, received: u64) -> Result<u64, String> {
        self.capture()?;
        self.verify()?;
        let file = self.payload.as_ref().ok_or("Download file released")?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if metadata.len() != received {
            return Err("Downloaded file size does not match native transfer completion".into());
        }
        self.stage.sync_file("payload", file)?;
        self.root.validate_destination(&self.name, self.replace)?;
        self.stage
            .place("payload", file, &self.root, &self.name, self.replace)?;
        self.placed = true;
        Ok(metadata.len())
    }
    /// May be called only after terminal CEF settlement or after CefShutdown.
    pub fn cleanup(&mut self) -> Result<(), String> {
        self.root.verify_child(&self.stage_name, &self.stage)?;
        if !self.placed && !self.removed {
            self.capture()?;
            if let Some(file) = &self.payload {
                self.stage.remove_file_if_owned("payload", file)?;
            }
            self.removed = true;
        }
        // Windows requires file references to be released before directory removal.
        drop(self.payload.take());
        self.root.remove_dir(&self.stage_name, &mut self.stage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};
    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "bunly-download-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let builder = fs::DirBuilder::new();
            #[cfg(unix)]
            let mut builder = builder;
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&path).unwrap();
            let path = fs::canonicalize(path).unwrap();
            #[cfg(windows)]
            let path = {
                use std::{
                    ffi::OsString,
                    os::windows::ffi::{OsStrExt, OsStringExt},
                };
                let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
                assert_eq!(&encoded[..4], &[92, 92, 63, 92]);
                PathBuf::from(OsString::from_wide(&encoded[4..]))
            };
            Self(path)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn write(stage: &mut Staging, bytes: &[u8]) {
        stage.begin().unwrap();
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(stage.path())
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
    #[test]
    fn filenames_reject_paths_aliases_and_platform_devices() {
        for name in ["artifact.bin", "report-1.txt", "A_b.C"] {
            assert!(valid_name(name), "{name}");
        }
        for name in [
            "",
            ".hidden",
            "../escape",
            "a/b",
            "a\\b",
            "a:",
            "a.",
            "a ",
            "CON",
            "con.txt",
            "COM1.bin",
            "LPT9",
            "föo",
            "a\n",
        ] {
            assert!(!valid_name(name), "{name}");
        }
    }
    #[test]
    fn completion_places_exact_bytes_and_cleans_only_its_stage() {
        let root = Root::new();
        fs::write(root.0.join("unrelated"), b"keep").unwrap();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"native bytes");
        assert_eq!(stage.commit(12).unwrap(), 12);
        stage.cleanup().unwrap();
        assert_eq!(
            fs::read(root.0.join("result.bin")).unwrap(),
            b"native bytes"
        );
        assert_eq!(fs::read(root.0.join("unrelated")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
    }
    #[test]
    fn cancellation_and_byte_mismatch_never_publish_partial_content() {
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"partial");
        assert!(stage.commit(10).is_err());
        stage.cleanup().unwrap();
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
    #[test]
    fn overwrite_is_explicit_and_collision_at_commit_stays_intact() {
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"replacement");
        fs::write(root.0.join("result.bin"), b"original").unwrap();
        assert!(stage.commit(11).is_err());
        stage.cleanup().unwrap();
        assert_eq!(fs::read(root.0.join("result.bin")).unwrap(), b"original");
        assert!(Staging::prepare(&root.0, "result.bin", false).is_err());
        let mut stage = Staging::prepare(&root.0, "result.bin", true).unwrap();
        write(&mut stage, b"replacement");
        stage.commit(11).unwrap();
        stage.cleanup().unwrap();
        assert_eq!(fs::read(root.0.join("result.bin")).unwrap(), b"replacement");
    }
    #[test]
    fn staging_refuses_case_aliases_and_non_file_targets() {
        let root = Root::new();
        fs::write(root.0.join("Report.txt"), b"original").unwrap();
        assert!(Staging::prepare(&root.0, "report.txt", true).is_err());
        fs::create_dir(root.0.join("directory")).unwrap();
        assert!(Staging::prepare(&root.0, "directory", true).is_err());
    }
    #[test]
    fn a_hard_link_cannot_be_overwritten_as_a_single_owned_destination() {
        let root = Root::new();
        fs::write(root.0.join("original"), b"keep").unwrap();
        fs::hard_link(root.0.join("original"), root.0.join("alias")).unwrap();
        assert!(Staging::prepare(&root.0, "alias", true).is_err());
        assert_eq!(fs::read(root.0.join("original")).unwrap(), b"keep");
    }
    #[test]
    fn cleanup_never_recursively_deletes_an_unowned_staging_entry() {
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"partial");
        let unrelated = stage.path().with_file_name("unexpected");
        fs::write(&unrelated, b"keep").unwrap();
        assert!(stage.cleanup().is_err());
        assert_eq!(fs::read(unrelated).unwrap(), b"keep");
        assert!(!root.0.join("result.bin").exists());
    }
    #[cfg(unix)]
    #[test]
    fn another_users_write_access_makes_a_download_root_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        let root = Root::new();
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(Staging::prepare(&root.0, "result.bin", false).is_err());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
    #[cfg(windows)]
    #[test]
    fn pinned_windows_root_cannot_be_renamed_during_a_download() {
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"owned");
        assert!(fs::rename(&root.0, root.0.with_extension("moved")).is_err());
        stage.cleanup().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn chromium_umask_permissions_are_tightened_through_the_owned_inode() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"native bytes");
        fs::set_permissions(stage.path(), fs::Permissions::from_mode(0o644)).unwrap();
        stage.capture().unwrap();
        let original = stage.payload.as_ref().unwrap().metadata().unwrap();
        stage.commit(12).unwrap();
        stage.cleanup().unwrap();
        let published = fs::metadata(root.0.join("result.bin")).unwrap();
        assert_eq!(published.ino(), original.ino());
        assert_eq!(published.dev(), original.dev());
        assert_eq!(published.mode() & 0o7777, 0o600);
        assert_eq!(
            fs::read(root.0.join("result.bin")).unwrap(),
            b"native bytes"
        );
    }
    #[cfg(unix)]
    #[test]
    fn publication_preserves_platform_extended_security_metadata() {
        use std::os::fd::AsRawFd;
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"metadata");
        stage.capture().unwrap();
        let file = stage.payload.as_ref().unwrap();
        #[cfg(target_os = "linux")]
        let attribute = c"user.bunly-download-security";
        #[cfg(target_os = "macos")]
        let attribute = c"com.apple.quarantine";
        let metadata = b"0081;00000000;Bunly fixture;";
        #[cfg(target_os = "linux")]
        let set = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                attribute.as_ptr(),
                metadata.as_ptr().cast(),
                metadata.len(),
                0,
            )
        };
        #[cfg(target_os = "macos")]
        let set = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                attribute.as_ptr(),
                metadata.as_ptr().cast(),
                metadata.len(),
                0,
                0,
            )
        };
        assert_eq!(set, 0, "{}", std::io::Error::last_os_error());
        stage.commit(8).unwrap();
        stage.cleanup().unwrap();
        let file = File::open(root.0.join("result.bin")).unwrap();
        let mut actual = [0u8; 128];
        #[cfg(target_os = "linux")]
        let size = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                attribute.as_ptr(),
                actual.as_mut_ptr().cast(),
                actual.len(),
            )
        };
        #[cfg(target_os = "macos")]
        let size = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                attribute.as_ptr(),
                actual.as_mut_ptr().cast(),
                actual.len(),
                0,
                0,
            )
        };
        assert_eq!(size, metadata.len() as isize);
        assert_eq!(&actual[..metadata.len()], metadata);
    }
    #[cfg(windows)]
    #[test]
    fn publication_preserves_windows_zone_identifier_stream() {
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"metadata");
        let zone = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        fs::write(format!("{}:Zone.Identifier", stage.path().display()), zone).unwrap();
        stage.commit(8).unwrap();
        stage.cleanup().unwrap();
        assert_eq!(
            fs::read(format!(
                "{}:Zone.Identifier",
                root.0.join("result.bin").display()
            ))
            .unwrap(),
            zone
        );
    }
    #[cfg(unix)]
    #[test]
    fn renamed_root_cannot_redirect_final_placement_or_cleanup() {
        let root = Root::new();
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"owned");
        let moved = root.0.with_extension("moved");
        fs::rename(&root.0, &moved).unwrap();
        fs::create_dir(&root.0).unwrap();
        fs::write(root.0.join("unrelated"), b"keep").unwrap();
        assert!(stage.commit(5).is_err());
        stage.cleanup().unwrap();
        assert_eq!(fs::read(root.0.join("unrelated")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);
        fs::remove_dir(moved).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlink_replacement_never_erases_its_target_or_an_unowned_inode() {
        use std::os::unix::fs::symlink;
        let root = Root::new();
        fs::write(root.0.join("unrelated"), b"keep").unwrap();
        symlink(root.0.join("unrelated"), root.0.join("link")).unwrap();
        assert!(Staging::prepare(&root.0, "link", true).is_err());
        let mut stage = Staging::prepare(&root.0, "result.bin", false).unwrap();
        write(&mut stage, b"owned");
        stage.capture().unwrap();
        fs::remove_file(stage.path()).unwrap();
        symlink(root.0.join("unrelated"), stage.path()).unwrap();
        assert!(stage.verify().is_err());
        assert!(stage.cleanup().is_err());
        assert_eq!(fs::read(root.0.join("unrelated")).unwrap(), b"keep");
    }
}
