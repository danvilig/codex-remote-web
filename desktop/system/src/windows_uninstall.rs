use std::{
    fs,
    hash::{DefaultHasher, Hash, Hasher},
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::Threading::{
        CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, INFINITE, OpenEventW, OpenMutexW,
        ReleaseMutex, SYNCHRONIZATION_SYNCHRONIZE, SetEvent, WaitForSingleObject,
    },
};

pub struct TrayShutdown {
    event: Vec<u16>,
    running: Vec<u16>,
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() {
        Err(io::Error::last_os_error())
    } else {
        // Each caller supplies a new kernel handle and transfers ownership.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

impl TrayShutdown {
    pub fn new(executable: &Path) -> io::Result<Self> {
        let mut hash = DefaultHasher::new();
        fs::canonicalize(executable)?.hash(&mut hash);
        // The installer service can run in a different session. The default DACL
        // limits these objects to the user and trusted OS principals.
        let prefix = format!("Global\\CodexRemoteWeb-{:016x}", hash.finish());
        let name = |suffix| format!("{prefix}-{suffix}\0").encode_utf16().collect();
        Ok(Self {
            event: name("uninstall"),
            running: name("tray-running"),
        })
    }

    pub fn listen(&self, app: &tauri::AppHandle) -> io::Result<OwnedHandle> {
        let event = owned(unsafe { CreateEventW(ptr::null(), 0, 0, self.event.as_ptr()) })?;
        // The GUI thread owns the mutex until it exits. The installer can then
        // continue even if the GUI exited just before handling the signal.
        let running = owned(unsafe { CreateMutexW(ptr::null(), 1, self.running.as_ptr()) })?;
        if io::Error::last_os_error().raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Tray shutdown is already registered",
            ));
        }
        let app = app.clone();
        std::thread::Builder::new()
            .name("tray-uninstall".into())
            .spawn(move || {
                if unsafe { WaitForSingleObject(event.as_raw_handle(), INFINITE) } == WAIT_OBJECT_0
                {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || super::quit(&handle));
                }
            })?;
        Ok(running)
    }

    pub fn close(&self) -> io::Result<()> {
        let running = match owned(unsafe {
            OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, self.running.as_ptr())
        }) {
            Ok(handle) => handle,
            Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        // The installer owns no GUI handle; the mutex also covers an exit
        // concurrent with opening or setting the event.
        let event = owned(unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, self.event.as_ptr()) });
        let signalled = event.and_then(|event| {
            if unsafe { SetEvent(event.as_raw_handle()) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
        let timeout = if signalled.is_ok() { 15_000 } else { 0 };
        match unsafe { WaitForSingleObject(running.as_raw_handle(), timeout) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => {
                unsafe { ReleaseMutex(running.as_raw_handle()) };
                Ok(())
            }
            WAIT_TIMEOUT => {
                signalled?;
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "The tray did not exit for uninstall",
                ))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }
}
