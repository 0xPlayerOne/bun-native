use std::{
    ffi::{CStr, CString},
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
};

pub(super) struct Directory(File);
fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn name(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Invalid native file component".into())
}
#[allow(clippy::unnecessary_cast)] // Darwin's u16 mode_t needs C varargs integer promotion.
fn open_at(fd: i32, component: &CStr, flags: i32, mode: libc::mode_t) -> Result<File, String> {
    let opened = unsafe {
        libc::openat(
            fd,
            component.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode as libc::c_uint,
        )
    };
    if opened < 0 {
        Err(error())
    } else {
        Ok(unsafe { File::from_raw_fd(opened) })
    }
}
fn same(left: &File, right: &File) -> Result<bool, String> {
    let left = left.metadata().map_err(|error| error.to_string())?;
    let right = right.metadata().map_err(|error| error.to_string())?;
    Ok(left.dev() == right.dev() && left.ino() == right.ino())
}
fn inspect(fd: i32, component: &CStr) -> Result<Option<libc::stat>, String> {
    let mut stat = std::mem::MaybeUninit::uninit();
    if unsafe {
        libc::fstatat(
            fd,
            component.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0
    {
        Ok(Some(unsafe { stat.assume_init() }))
    } else if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
        Ok(None)
    } else {
        Err(error())
    }
}
fn errno() -> *mut i32 {
    #[cfg(target_os = "linux")]
    {
        unsafe { libc::__errno_location() }
    }
    #[cfg(target_os = "macos")]
    {
        unsafe { libc::__error() }
    }
}
impl Directory {
    pub fn handle_count(&self) -> usize {
        1
    }
    pub fn open_root(path: &Path) -> Result<Self, String> {
        if !path.is_absolute() {
            return Err("Download root must be absolute".into());
        }
        let mut current = open_at(libc::AT_FDCWD, c"/", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        for part in path.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(value) => {
                    let component =
                        CString::new(value.as_bytes()).map_err(|_| "Invalid root component")?;
                    current = open_at(
                        current.as_raw_fd(),
                        &component,
                        libc::O_RDONLY | libc::O_DIRECTORY,
                        0,
                    )?;
                }
                _ => return Err("Unsafe download root component".into()),
            }
        }
        let metadata = current.metadata().map_err(|error| error.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err(
                "Download root must be owned by this user and not writable by other users".into(),
            );
        }
        Ok(Self(current))
    }
    pub fn verify_path(&self, path: &Path) -> Result<(), String> {
        let current = Self::open_root(path)?;
        if same(&self.0, &current.0)? {
            Ok(())
        } else {
            Err("Download root was replaced".into())
        }
    }
    pub fn create_private_dir(&self, component: &str) -> Result<Self, String> {
        let component = name(component)?;
        if unsafe { libc::mkdirat(self.0.as_raw_fd(), component.as_ptr(), 0o700) } != 0 {
            return Err(error());
        }
        let file = open_at(
            self.0.as_raw_fd(),
            &component,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("Download staging directory is not private".into());
        }
        Ok(Self(file))
    }
    pub fn open_file(&self, component: &str) -> Result<Option<File>, String> {
        if inspect(self.0.as_raw_fd(), &name(component)?)?.is_none() {
            return Ok(None);
        }
        let file = open_at(
            self.0.as_raw_fd(),
            &name(component)?,
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        )?;
        self.verify_file(component, &file)?;
        Ok(Some(file))
    }
    pub fn sync_file(&self, component: &str, file: &File) -> Result<(), String> {
        self.verify_file(component, file)?;
        // Chromium's move applies umask-derived permissions (often 0644).
        // The 0700 stage contains them until this verified inode is made private.
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err(error());
        }
        self.verify_file(component, file)?;
        if file.metadata().map_err(|error| error.to_string())?.mode() & 0o7777 != 0o600 {
            return Err("Download inode permissions did not become private".into());
        }
        file.sync_all().map_err(|error| error.to_string())
    }
    pub fn verify_child(&self, component: &str, child: &Self) -> Result<(), String> {
        let current = open_at(
            self.0.as_raw_fd(),
            &name(component)?,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        if same(&current, &child.0)? {
            Ok(())
        } else {
            Err("Download staging directory was replaced".into())
        }
    }
    #[allow(clippy::unnecessary_cast)] // Darwin dev_t differs from Rust MetadataExt::dev().
    pub fn verify_file(&self, component: &str, file: &File) -> Result<(), String> {
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        let current = inspect(self.0.as_raw_fd(), &name(component)?)?
            .ok_or("Download staging file disappeared")?;
        if !metadata.is_file()
            || current.st_mode & libc::S_IFMT != libc::S_IFREG
            || metadata.nlink() != 1
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.dev() as libc::dev_t != current.st_dev
            || metadata.ino() as libc::ino_t != current.st_ino
        {
            return Err(
                "Download staging file was replaced or is not a private regular file".into(),
            );
        }
        Ok(())
    }
    pub fn validate_destination(&self, component: &str, replace: bool) -> Result<(), String> {
        // Inspect the open directory, never an unpinned pathname. A fresh open
        // description gives readdir its own offset instead of modifying ours.
        let copy = open_at(
            self.0.as_raw_fd(),
            c".",
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        use std::os::fd::IntoRawFd;
        let descriptor = copy.into_raw_fd();
        let directory = unsafe { libc::fdopendir(descriptor) };
        if directory.is_null() {
            unsafe {
                libc::close(descriptor);
            }
            return Err(error());
        }
        struct Entries(*mut libc::DIR);
        impl Drop for Entries {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let entries = Entries(directory);
        let mut count = 0;
        let mut exact = false;
        loop {
            unsafe {
                *errno() = 0;
            }
            let entry = unsafe { libc::readdir(entries.0) };
            if entry.is_null() {
                if unsafe { *errno() } != 0 {
                    return Err(error());
                }
                break;
            }
            count += 1;
            if count > 4098 {
                return Err("Download directory inspection bound exceeded".into());
            }
            let actual = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            exact |= actual == component.as_bytes();
            if actual.eq_ignore_ascii_case(component.as_bytes()) && actual != component.as_bytes() {
                return Err("Case-colliding download destination denied".into());
            }
        }
        if let Some(target) = inspect(self.0.as_raw_fd(), &name(component)?)? {
            if !replace {
                return Err("Download destination already exists".into());
            }
            if !exact {
                return Err("Download destination spelling resolves to an alias".into());
            }
            if target.st_mode & libc::S_IFMT != libc::S_IFREG || target.st_nlink != 1 {
                return Err("Download replacement requires a regular non-aliased file".into());
            }
        }
        Ok(())
    }
    pub fn place(
        &self,
        component: &str,
        file: &File,
        root: &Self,
        target: &str,
        replace: bool,
    ) -> Result<(), String> {
        self.verify_file(component, file)?;
        let component = name(component)?;
        let target = name(target)?;
        if replace {
            if unsafe {
                libc::renameat(
                    self.0.as_raw_fd(),
                    component.as_ptr(),
                    root.0.as_raw_fd(),
                    target.as_ptr(),
                )
            } != 0
            {
                return Err(error());
            }
        } else {
            // Atomic no-clobber rename preserves security attributes and all
            // other inode metadata. Unsupported filesystems fail, never copy.
            #[cfg(target_os = "linux")]
            let result = unsafe {
                libc::renameat2(
                    self.0.as_raw_fd(),
                    component.as_ptr(),
                    root.0.as_raw_fd(),
                    target.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            #[cfg(target_os = "macos")]
            let result = unsafe {
                libc::renameatx_np(
                    self.0.as_raw_fd(),
                    component.as_ptr(),
                    root.0.as_raw_fd(),
                    target.as_ptr(),
                    libc::RENAME_EXCL,
                )
            };
            if result != 0 {
                return Err(error());
            }
        }
        Ok(())
    }
    pub fn remove_file_if_owned(&self, component: &str, file: &File) -> Result<(), String> {
        let component_name = name(component)?;
        if inspect(self.0.as_raw_fd(), &component_name)?.is_none() {
            return if file.metadata().map_err(|error| error.to_string())?.nlink() == 0 {
                Ok(())
            } else {
                Err("Owned download file was moved; refusing cleanup".into())
            };
        }
        self.verify_file(component, file)?;
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), component_name.as_ptr(), 0) } != 0 {
            return Err(error());
        }
        Ok(())
    }
    pub fn remove_dir(&self, component: &str, child: &mut Self) -> Result<(), String> {
        self.verify_child(component, child)?;
        if unsafe {
            libc::unlinkat(
                self.0.as_raw_fd(),
                name(component)?.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        } != 0
        {
            return Err(error());
        }
        Ok(())
    }
}
