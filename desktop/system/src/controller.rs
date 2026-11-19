use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const REQUEST_LIMIT: usize = 16 * 1024;
const REPLY_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
}

impl Reply {
    pub fn success(value: Value) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
            code: None,
            status: None,
        }
    }

    pub fn failure(error: &str) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error.into()),
            code: None,
            status: None,
        }
    }
}

pub struct Controller {
    installation: PathBuf,
    gateway: PathBuf,
}

impl Controller {
    pub fn new(installation: PathBuf, gateway: PathBuf) -> Self {
        Self {
            installation,
            gateway,
        }
    }

    fn gateway(&self) -> Command {
        let name = if cfg!(windows) {
            "codex-remote-web.exe"
        } else {
            "codex-remote-web"
        };
        let mut command = Command::new(self.gateway.join(name));
        command
            .current_dir(&self.gateway)
            .env("CODEX_WEBUI_DESKTOP_INSTALLATION", &self.installation)
            .env_remove("CODEX_WEBUI_DESKTOP_PIPE_PARENT");
        hide_console(&mut command);
        command
    }

    pub fn call(&self, action: &str, body: Value) -> Reply {
        match self.request(action, body) {
            Ok(reply) => reply,
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                Reply::failure("Desktop request is too large")
            }
            Err(_) => Reply::failure(
                "The native gateway did not answer. Check the installation and try again.",
            ),
        }
    }

    fn request(&self, action: &str, body: Value) -> io::Result<Reply> {
        let input = serde_json::to_vec(&json!({"action": action, "body": body}))?;
        if input.len() > REQUEST_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "desktop request limit exceeded",
            ));
        }
        let mut child = self
            .gateway()
            .args(["native-operation".as_ref(), self.installation.as_os_str()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child.stdin.take().expect("piped child input");
        let stdout = child.stdout.take().expect("piped child output");
        let output = thread::spawn(move || -> io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            stdout
                .take(REPLY_LIMIT as u64 + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        });
        let write = thread::spawn(move || stdin.write_all(&input));
        let deadline = Instant::now() + Duration::from_secs(125);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                error => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break match error {
                        Err(error) => Err(error),
                        _ => Err(io::ErrorKind::TimedOut.into()),
                    };
                }
            }
        };
        let _ = write.join();
        let bytes = output.join().map_err(|_| io::ErrorKind::BrokenPipe)??;
        if !status?.success() || bytes.len() > REPLY_LIMIT {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let reply = serde_json::from_slice::<Reply>(&bytes)?;
        Ok(reply)
    }

    pub fn ensure(&self) -> Reply {
        let ready = self.call("prepareAgent", Value::Null);
        if !ready.ok || ready.value == Some(Value::Bool(true)) {
            return ready;
        }
        let mut command = Command::new(&self.installation);
        command
            .arg("--background-agent")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_remove("CODEX_WEBUI_DESKTOP_PIPE_PARENT");
        detach(&mut command);
        let Ok(mut child) = command.spawn() else {
            return Reply::failure("Could not start the background component");
        };
        thread::spawn(move || {
            let _ = child.wait();
        });
        for _ in 0..150 {
            let reply = self.call("status", Value::Null);
            if reply.ok
                || reply
                    .code
                    .as_deref()
                    .is_some_and(|code| !matches!(code, "AGENT_ABSENT" | "AGENT_OFFLINE"))
            {
                return reply;
            }
            thread::sleep(Duration::from_millis(100));
        }
        Reply::failure(
            "Background agent could not start. Check installation and private directory permissions.",
        )
    }

    pub fn background(&self) -> io::Result<()> {
        let mut child = self
            .gateway()
            .arg("agent")
            .env("CODEX_WEBUI_DESKTOP_PIPE_PARENT", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        // Retain the writer while the background shell lives. An OS kill or
        // logout closes it so the Go supervisor can reap its gateway workers.
        let parent_pipe = child.stdin.take();
        let status = child.wait()?;
        drop(parent_pipe);
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(
                "native background component stopped unexpectedly",
            ))
        }
    }
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn hide_console(_: &mut Command) {}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
}

#[cfg(not(windows))]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

pub fn tray_host_available() -> bool {
    if cfg!(windows) {
        return true;
    }
    if env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return false;
    }
    Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--timeout",
            "2",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            "org.kde.StatusNotifierWatcher",
        ])
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|reply| reply.status.success() && reply.stdout.starts_with(b"(true,"))
}
