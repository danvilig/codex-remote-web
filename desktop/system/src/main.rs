#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod controller;

use controller::{Controller, Reply};
use serde_json::{Value, json};
use std::{
    env, fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const TITLE: &str = "Codex Remote Web";
const PAGE_LABEL: &str = "settings";
const TRAY: &str = "gateway";
const INIT: &str = include_str!("settings.js");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
const ORIGINAL_META: &str = "connect-src 'none'";
const INVOKE_META: &str = "connect-src ipc: http://ipc.localhost; frame-src 'none'";

fn page_base() -> &'static str {
    if cfg!(windows) {
        "http://crw.localhost"
    } else {
        "crw://localhost"
    }
}

fn trusted_page(url: &Url) -> bool {
    url.as_str() == format!("{}/index.html", page_base())
}

fn external_url(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.host().is_some()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()))
        && url.as_str().len() < 2048
}

fn open_external(url: &Url) {
    if external_url(url) {
        let _ = open::that_detached(url.as_str());
    }
}

fn settings_asset(
    root: &std::path::Path,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Response, StatusCode, header};
    let response = |status, mime, body| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_SECURITY_POLICY, CSP)
            .header("X-Content-Type-Options", "nosniff")
            .header("Referrer-Policy", "no-referrer")
            .body(body)
            .expect("static response headers")
    };
    if request.method() != tauri::http::Method::GET || request.uri().query().is_some() {
        return response(StatusCode::NOT_FOUND, "text/plain", vec![]);
    }
    let (name, mime) = match request.uri().path() {
        "/index.html" => ("index.html", "text/html; charset=utf-8"),
        "/renderer.js" => ("renderer.js", "text/javascript; charset=utf-8"),
        "/desktop.css" => ("desktop.css", "text/css; charset=utf-8"),
        "/style.css" => ("style.css", "text/css; charset=utf-8"),
        "/workspace.css" => ("workspace.css", "text/css; charset=utf-8"),
        "/remote-access.css" => ("remote-access.css", "text/css; charset=utf-8"),
        _ => return response(StatusCode::NOT_FOUND, "text/plain", vec![]),
    };
    match fs::read(root.join(name)) {
        Ok(bytes) if name == "index.html" => match String::from_utf8(bytes) {
            Ok(html) if html.matches(ORIGINAL_META).count() == 1 => response(
                StatusCode::OK,
                mime,
                html.replace(ORIGINAL_META, INVOKE_META).into_bytes(),
            ),
            _ => response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", vec![]),
        },
        Ok(bytes) => response(StatusCode::OK, mime, bytes),
        Err(_) => response(StatusCode::NOT_FOUND, "text/plain", vec![]),
    }
}

struct Settings {
    controller: Controller,
    assets: PathBuf,
    tray_available: AtomicBool,
    closing: AtomicBool,
    chinese: AtomicBool,
}

fn system_chinese() -> bool {
    sys_locale::get_locales()
        .find_map(|language| match language.split(['-', '_']).next() {
            Some("zh") => Some(true),
            Some("en") => Some(false),
            _ => None,
        })
        .unwrap_or(false)
}

fn label(chinese: bool, en: &'static str, zh: &'static str) -> &'static str {
    if chinese { zh } else { en }
}

fn update_language(app: &AppHandle, reply: &mut Reply) {
    let settings = app.state::<Settings>();
    if !reply.ok {
        return;
    }
    if let Some(value) = reply.value.as_mut().and_then(Value::as_object_mut) {
        value.insert(
            "systemLocale".into(),
            json!(if system_chinese() { "zh-CN" } else { "en" }),
        );
        if let Some(preference) = value
            .get("config")
            .and_then(|v| v.get("language"))
            .and_then(Value::as_str)
        {
            let chinese = match preference {
                "zh" => true,
                "en" => false,
                _ => system_chinese(),
            };
            if settings.chinese.swap(chinese, Ordering::Relaxed) != chinese {
                let app = app.clone();
                let handle = app.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(tray) = app.tray_by_id(TRAY) {
                        if let Ok(new_menu) = tray_menu(&app, chinese) {
                            let _ = tray.set_menu(Some(new_menu));
                        }
                    }
                });
            }
        }
    }
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PAGE_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_workspace(app: &AppHandle) -> Reply {
    let status = app
        .state::<Settings>()
        .controller
        .call("status", Value::Null);
    if !status.ok {
        return status;
    }
    if let Some(value) = status
        .value
        .as_ref()
        .and_then(|v| v.get("url"))
        .and_then(Value::as_str)
    {
        if let Ok(url) = Url::parse(value) {
            open_external(&url);
        }
    }
    Reply::success(Value::Null)
}

fn configure_window(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        PAGE_LABEL,
        WebviewUrl::CustomProtocol(
            Url::parse(&format!("{}/index.html", page_base())).expect("static settings URL"),
        ),
    )
    .title(TITLE)
    .inner_size(1100.0, 800.0)
    .min_inner_size(660.0, 540.0)
    .visible(false)
    .incognito(true)
    .devtools(false)
    .initialization_script(INIT)
    .on_navigation(trusted_page)
    .on_new_window(|url, _| {
        open_external(&url);
        NewWindowResponse::Deny
    })
    .build()?;
    let handle = app.clone();
    let event_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let state = handle.state::<Settings>();
            if !state.closing.load(Ordering::Relaxed) {
                api.prevent_close();
                if state.tray_available.load(Ordering::Relaxed) {
                    let _ = event_window.hide();
                } else {
                    let _ = event_window.minimize();
                }
            }
        }
    });
    Ok(())
}

fn tray_menu(app: &AppHandle, chinese: bool) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let entries = [
        ("settings", "Settings", "设置"),
        ("workspace", "Open workspace", "打开工作区"),
        ("start", "Start gateway", "启动网关"),
        ("stop", "Stop gateway", "停止网关"),
        (
            "quit",
            "Quit tray (gateway continues)",
            "退出托盘（网关继续运行）",
        ),
    ];
    let mut menu = MenuBuilder::new(app);
    for (id, en, zh) in entries {
        if id == "start" || id == "quit" {
            menu = menu.separator();
        }
        menu = menu.item(&MenuItemBuilder::with_id(id, label(chinese, en, zh)).build(app)?);
    }
    menu.build()
}

fn quit(app: &AppHandle) {
    app.state::<Settings>()
        .closing
        .store(true, Ordering::Relaxed);
    app.exit(0);
}

fn configure_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let settings = app.state::<Settings>();
    if !controller::tray_host_available() {
        return Ok(());
    }
    TrayIconBuilder::with_id(TRAY)
        .icon(Image::from_path(settings.assets.join("tray.png"))?)
        .tooltip(TITLE)
        .menu(&tray_menu(app, settings.chinese.load(Ordering::Relaxed))?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_settings(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => show_settings(app),
            "quit" => quit(app),
            "workspace" | "start" | "stop" => {
                let app = app.clone();
                let id = event.id().as_ref().to_owned();
                tauri::async_runtime::spawn_blocking(move || {
                    let reply = match id.as_str() {
                        "workspace" => open_workspace(&app),
                        "start" => app
                            .state::<Settings>()
                            .controller
                            .call("start", Value::Null),
                        _ => app.state::<Settings>().controller.call("stop", Value::Null),
                    };
                    if !reply.ok {
                        app.dialog()
                            .message(reply.error.unwrap_or_default())
                            .title(TITLE)
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                });
            }
            _ => {}
        })
        .build(app)?;
    settings.tray_available.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn desktop_operation(
    window: WebviewWindow,
    app: AppHandle,
    action: String,
    body: Option<Value>,
) -> Reply {
    if window.label() != PAGE_LABEL || !window.url().is_ok_and(|url| trusted_page(&url)) {
        return Reply::failure("Untrusted desktop request");
    }
    match action.as_str() {
        "status" | "dependencies" | "config" | "start" | "stop" | "restart" | "setup"
        | "language" | "openWorkspace" | "removeBackground" | "cleanUninstall"
        | "chooseDirectory" | "chooseCodex" | "chooseCloudflared" => {}
        _ => return Reply::failure("Unsupported desktop action"),
    }
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<Settings>();
        let chinese = settings.chinese.load(Ordering::Relaxed);
        if matches!(action.as_str(), "chooseDirectory" | "chooseCodex" | "chooseCloudflared") {
            let picker = app.dialog().file().set_parent(&window);
            let selected = if action == "chooseDirectory" { picker.blocking_pick_folder() } else { picker.blocking_pick_file() };
            return Reply::success(selected.and_then(|path| path.into_path().ok()).map_or(Value::Null, |path| json!(path)));
        }
        if action == "openWorkspace" { return open_workspace(&app); }
        if matches!(action.as_str(), "removeBackground" | "cleanUninstall") {
            let cleanup = action == "cleanUninstall";
            let (title, message, confirm) = if cleanup {
                (label(chinese, "Clean up and quit?", "清理并退出？"), label(chinese, "Remove app settings, caches, and saved management tokens. Projects and your Codex account are preserved. Then uninstall the application using your system package manager.", "移除应用设置、缓存和已保存的管理令牌，保留项目和 Codex 账户。随后请通过系统的软件包管理器卸载应用。"), label(chinese, "Clean up", "清理"))
            } else {
                (label(chinese, "Stop and remove the background component?", "停止并移除后台组件？"), label(chinese, "Your projects, credentials and remote deployment records will be preserved.", "项目、凭据与远程部署记录将保留。"), label(chinese, "Remove", "移除"))
            };
            if !app.dialog().message(message).title(title).kind(MessageDialogKind::Warning).parent(&window)
                .buttons(MessageDialogButtons::OkCancelCustom(confirm.into(), label(chinese, "Cancel", "取消").into())).blocking_show() {
                return Reply::success(Value::Null);
            }
        }
        let mut reply = settings.controller.call(&action, body.unwrap_or(Value::Null));
        if matches!(action.as_str(), "config" | "language" | "status") { update_language(&app, &mut reply); }
        if action == "cleanUninstall" && reply.ok { quit(&app); }
        reply
    }).await.unwrap_or_else(|_| Reply::failure("Desktop operation failed"))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let executable = env::current_exe()?;
    let resources = executable
        .parent()
        .ok_or("Invalid desktop executable")?
        .join("resources");
    let assets = resources.join("desktop");
    let controller = Controller::new(executable, resources.join("gateway"));
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args
        .iter()
        .any(|arg| arg == "--background-agent" || arg == "--background")
    {
        return controller.background().map_err(Into::into);
    }
    if args.iter().any(|arg| arg == "--uninstall-background") {
        let reply = controller.call("removeBackground", Value::Null);
        return if reply.ok {
            Ok(())
        } else {
            Err(reply
                .error
                .unwrap_or_else(|| "Background removal failed".into())
                .into())
        };
    }
    let launch_workspace = args.iter().any(|arg| arg == "--open-workspace");
    let protocol_assets = assets.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
            show_settings(app);
            if arguments.iter().any(|arg| arg == "--open-workspace") {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || open_workspace(&app));
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("crw", move |_, request| {
            settings_asset(&protocol_assets, request)
        })
        .manage(Settings {
            controller,
            assets,
            tray_available: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            chinese: AtomicBool::new(system_chinese()),
        })
        .invoke_handler(tauri::generate_handler![desktop_operation])
        .setup(move |app| {
            configure_window(app.handle())?;
            let _ = configure_tray(app.handle());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let initial = handle.state::<Settings>().controller.ensure();
                let mut status = if initial.ok {
                    handle
                        .state::<Settings>()
                        .controller
                        .call("status", Value::Null)
                } else {
                    initial
                };
                update_language(&handle, &mut status);
                let app = handle.clone();
                let _ = handle.run_on_main_thread(move || show_settings(&app));
                if !status.ok {
                    handle
                        .dialog()
                        .message(status.error.unwrap_or_default())
                        .title(TITLE)
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                } else if launch_workspace {
                    let _ = open_workspace(&handle);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Codex Remote Web: {error}");
        std::process::exit(1);
    }
}
