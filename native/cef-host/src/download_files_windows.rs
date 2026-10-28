//! Windows pins root ancestors without delete sharing, rejects reparse points,
//! uses a protected per-user staging DACL, and renames the source by handle.
use std::{
    fs::{self, File},
    mem::{offset_of, size_of, size_of_val, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr::{null, null_mut},
};
use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, LocalFree, RtlNtStatusToDosError, GENERIC_ALL, GENERIC_READ, GENERIC_WRITE,
        HANDLE, INVALID_HANDLE_VALUE,
    },
    Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
    Security::*,
    Storage::FileSystem::*,
    System::{
        SystemServices::{
            ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, FILE_NAMED_STREAMS,
            FILE_PERSISTENT_ACLS,
        },
        Threading::{GetCurrentProcess, OpenProcessToken},
        IO::IO_STATUS_BLOCK,
    },
};
pub(super) struct Directory {
    file: Option<File>,
    _ancestors: Vec<File>,
    path: PathBuf,
}
fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn open(
    path: &Path,
    access: u32,
    sharing: u32,
    disposition: u32,
    directory: bool,
) -> Result<File, String> {
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            access,
            sharing,
            null(),
            disposition,
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    FILE_ATTRIBUTE_NORMAL
                },
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    let info = information(&file)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err("Download path is a reparse point or wrong file type".into());
    }
    Ok(file)
}
fn information(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
    let mut info = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        Err(error())
    } else {
        Ok(info)
    }
}
fn same(left: &File, right: &File) -> Result<bool, String> {
    let a = information(left)?;
    let b = information(right)?;
    Ok(a.dwVolumeSerialNumber == b.dwVolumeSerialNumber
        && a.nFileIndexHigh == b.nFileIndexHigh
        && a.nFileIndexLow == b.nFileIndexLow)
}
fn with_user<T>(run: impl FnOnce(PSID) -> Result<T, String>) -> Result<T, String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(error());
    }
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let token = Token(token);
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut bytes);
    }
    if bytes == 0 || bytes > 4096 {
        return Err("Windows user identity is unavailable".into());
    }
    let mut user = vec![0u64; (bytes as usize).div_ceil(8)];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            user.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(error());
    }
    let user = unsafe { &*user.as_ptr().cast::<TOKEN_USER>() };
    run(user.User.Sid)
}
fn validate_owner(file: &File) -> Result<(), String> {
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32).to_string());
    }
    struct Descriptor(PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let _descriptor = Descriptor(descriptor);
    if owner.is_null()
        || acl.is_null()
        || unsafe { IsValidSid(owner) } == 0
        || unsafe { IsValidAcl(acl) } == 0
    {
        return Err("Download directory requires an owned, explicit Windows DACL".into());
    }
    with_user(|user| {
        if unsafe { EqualSid(owner, user) } == 0 {
            return Err("Download directory must belong to the current user".into());
        }
        let count = unsafe { (*acl).AceCount };
        if count > 256 {
            return Err("Download directory ACL inspection bound exceeded".into());
        }
        let write = GENERIC_ALL
            | GENERIC_WRITE
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER
            | FILE_ADD_FILE
            | FILE_ADD_SUBDIRECTORY
            | FILE_DELETE_CHILD
            | FILE_WRITE_ATTRIBUTES
            | FILE_WRITE_EA;
        for index in 0..u32::from(count) {
            let mut entry = null_mut();
            if unsafe { GetAce(acl, index, &mut entry) } == 0 || entry.is_null() {
                return Err(error());
            }
            let header = unsafe { &*entry.cast::<ACE_HEADER>() };
            if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0
                || u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE
            {
                continue;
            }
            if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
                || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
            {
                return Err("Unsupported download directory ACL entry".into());
            }
            let entry = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
            let sid = (&entry.SidStart as *const u32).cast_mut().cast();
            if unsafe { IsValidSid(sid) } == 0 {
                return Err("Invalid download directory ACL identity".into());
            }
            if entry.Mask & write != 0
                && unsafe { EqualSid(sid, user) } == 0
                && unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } == 0
                && unsafe { IsWellKnownSid(sid, WinBuiltinAdministratorsSid) } == 0
            {
                return Err("Download directory is writable by another user".into());
            }
        }
        Ok(())
    })
}
fn private_directory(path: &Path) -> Result<(), String> {
    with_user(|user| {
        let mut acl = [0u64; 128];
        let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
        let mut descriptor: SECURITY_DESCRIPTOR = unsafe { zeroed() };
        if unsafe { InitializeAcl(acl_ptr, size_of_val(&acl) as u32, ACL_REVISION) } == 0
            || unsafe {
                AddAccessAllowedAceEx(
                    acl_ptr,
                    ACL_REVISION,
                    OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                    FILE_ALL_ACCESS,
                    user,
                )
            } == 0
            || unsafe {
                InitializeSecurityDescriptor(
                    (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                    1,
                )
            } == 0
            || unsafe {
                SetSecurityDescriptorDacl(
                    (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                    1,
                    acl_ptr,
                    0,
                )
            } == 0
            || unsafe {
                SetSecurityDescriptorControl(
                    (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                    SE_DACL_PROTECTED,
                    SE_DACL_PROTECTED,
                )
            } == 0
        {
            return Err(error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: 0,
        };
        if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
            return Err(error());
        }
        Ok(())
    })
}
impl Directory {
    pub fn handle_count(&self) -> usize {
        usize::from(self.file.is_some()) + self._ancestors.len()
    }
    fn file(&self) -> Result<&File, String> {
        self.file
            .as_ref()
            .ok_or_else(|| "Download directory released".into())
    }
    pub fn open_root(path: &Path) -> Result<Self, String> {
        let mut components = path.components();
        if !matches!(components.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)))
            || !matches!(components.next(), Some(Component::RootDir))
        {
            return Err("Download roots require a local absolute drive path".into());
        }
        let mut current = path
            .ancestors()
            .last()
            .ok_or("Missing root drive")?
            .to_owned();
        let mut handles = vec![open(
            &current,
            READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            OPEN_EXISTING,
            true,
        )?];
        for part in components {
            if let Component::Normal(part) = part {
                current.push(part);
            } else {
                return Err("Unsafe download root component".into());
            }
            handles.push(open(
                &current,
                READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                OPEN_EXISTING,
                true,
            )?);
        }
        let root = handles.pop().ok_or("Missing native root handle")?;
        validate_owner(&root)?;
        let mut flags = 0;
        if unsafe {
            GetVolumeInformationByHandleW(
                root.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                &mut flags,
                null_mut(),
                0,
            )
        } == 0
            || flags & (FILE_PERSISTENT_ACLS | FILE_NAMED_STREAMS)
                != (FILE_PERSISTENT_ACLS | FILE_NAMED_STREAMS)
        {
            return Err("Download volume must preserve Windows ACLs and security streams".into());
        }
        Ok(Self {
            file: Some(root),
            _ancestors: handles,
            path: path.to_owned(),
        })
    }
    pub fn verify_path(&self, path: &Path) -> Result<(), String> {
        let current = Self::open_root(path)?;
        if same(self.file()?, current.file()?)? {
            Ok(())
        } else {
            Err("Download root was replaced".into())
        }
    }
    pub fn create_private_dir(&self, component: &str) -> Result<Self, String> {
        let path = self.path.join(component);
        private_directory(&path)?;
        let file = open(
            &path,
            READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            OPEN_EXISTING,
            true,
        )?;
        validate_owner(&file)?;
        Ok(Self {
            file: Some(file),
            _ancestors: vec![],
            path,
        })
    }
    pub fn open_file(&self, component: &str) -> Result<Option<File>, String> {
        if matches!(fs::symlink_metadata(self.path.join(component)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(None);
        }
        // Chromium uses exclusive write sharing while a transfer runs.
        let file = open(
            &self.path.join(component),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            false,
        )?;
        self.verify_file(component, &file)?;
        Ok(Some(file))
    }
    pub fn sync_file(&self, component: &str, file: &File) -> Result<(), String> {
        let current = open(
            &self.path.join(component),
            GENERIC_WRITE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            false,
        )?;
        if !same(&current, file)? {
            return Err("Download source was replaced".into());
        }
        current.sync_all().map_err(|error| error.to_string())
    }
    pub fn verify_child(&self, component: &str, child: &Self) -> Result<(), String> {
        let current = open(
            &self.path.join(component),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            true,
        )?;
        if same(&current, child.file()?)? {
            Ok(())
        } else {
            Err("Download staging directory was replaced".into())
        }
    }
    pub fn verify_file(&self, component: &str, file: &File) -> Result<(), String> {
        let current = open(
            &self.path.join(component),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            false,
        )?;
        if information(&current)?.nNumberOfLinks != 1 || !same(&current, file)? {
            return Err("Download staging file was replaced or aliased".into());
        }
        Ok(())
    }
    pub fn validate_destination(&self, component: &str, replace: bool) -> Result<(), String> {
        let mut exact = false;
        for (index, entry) in fs::read_dir(&self.path)
            .map_err(|error| error.to_string())?
            .enumerate()
        {
            if index >= 4096 {
                return Err("Download directory inspection bound exceeded".into());
            }
            let actual = entry.map_err(|error| error.to_string())?.file_name();
            if let Some(actual) = actual.to_str() {
                exact |= actual == component;
                if actual.eq_ignore_ascii_case(component) && actual != component {
                    return Err("Case-colliding download destination denied".into());
                }
            }
        }
        match fs::symlink_metadata(self.path.join(component)) {
            Ok(_) => {
                if !replace {
                    return Err("Download destination already exists".into());
                }
                if !exact {
                    return Err("Download destination spelling resolves to an alias".into());
                }
                let target = open(
                    &self.path.join(component),
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    OPEN_EXISTING,
                    false,
                )?;
                if information(&target)?.nNumberOfLinks != 1 {
                    return Err("Aliased download destination denied".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
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
        let source = open(
            &self.path.join(component),
            DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            false,
        )?;
        if !same(&source, file)? {
            return Err("Download source was replaced".into());
        }
        let encoded: Vec<u16> = target.encode_utf16().collect();
        let size = offset_of!(FILE_RENAME_INFORMATION, FileName) + (encoded.len() + 1) * 2;
        let mut storage = vec![0u64; size.div_ceil(8)];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        let mut completion = IO_STATUS_BLOCK::default();
        unsafe {
            (*info).Anonymous.ReplaceIfExists = replace;
            (*info).RootDirectory = root.file()?.as_raw_handle();
            (*info).FileNameLength = (encoded.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                encoded.as_ptr(),
                (*info).FileName.as_mut_ptr(),
                encoded.len(),
            );
            // Use the documented user-mode native call for a root-relative
            // rename. The hosted Windows Server 2022 run rejected this form in
            // the Win32 wrapper; an absolute destination would lose the pinned
            // directory handle as the final name-resolution authority.
            // `open` creates a synchronous handle (no FILE_FLAG_OVERLAPPED), so
            // the completion and filename buffers remain live through return.
            let status = NtSetInformationFile(
                source.as_raw_handle(),
                &mut completion,
                info.cast(),
                size as u32,
                FileRenameInformation,
            );
            if status < 0 {
                return Err(
                    std::io::Error::from_raw_os_error(RtlNtStatusToDosError(status) as i32)
                        .to_string(),
                );
            }
        }
        Ok(())
    }
    pub fn remove_file_if_owned(&self, component: &str, file: &File) -> Result<(), String> {
        // CEF cancellation may already have deleted its own staging entry.
        if matches!(fs::symlink_metadata(self.path.join(component)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(());
        }
        self.verify_file(component, file)?;
        let source = open(
            &self.path.join(component),
            DELETE | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            false,
        )?;
        if !same(&source, file)? {
            return Err("Download source was replaced".into());
        }
        let delete = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                source.as_raw_handle(),
                FileDispositionInfo,
                (&delete as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(error());
        }
        Ok(())
    }
    pub fn remove_dir(&self, component: &str, child: &mut Self) -> Result<(), String> {
        self.verify_child(component, child)?;
        let delete = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                child.file()?.as_raw_handle(),
                FileDispositionInfo,
                (&delete as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(error());
        }
        drop(child.file.take());
        Ok(())
    }
}
