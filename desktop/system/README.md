# Windows and Linux system desktop shell

Build with `cargo +1.95.0 build --locked --release --manifest-path desktop/system/Cargo.toml`. Use MSVC Build Tools with the Desktop development with C++ workload and Windows SDK on Windows. The installed application uses the system WebView2 runtime. On Ubuntu, install `build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev librsvg2-dev`. The installed application uses system WebKitGTK 4.1, GTK 3, and Ayatana AppIndicator 3. Release binaries belong to the target OS and architecture.

The Rust executable is named `codex-remote-web-desktop` (`.exe` on Windows). Package it beside `resources/desktop` (built settings page, renderer, CSS, and `tray.png`) and `resources/gateway` (native `codex-remote-web`, `.exe` on Windows, and its web assets). The existing Windows product executable name can be assigned during packaging. The small built-in icon comes from the project's `desktop/assets/app-icon.png`; the settings assets stay in the package directory.

The shell accepts `--background-agent` (also `--background`), `--uninstall-background`, and `--open-workspace`. It runs the Go helper using `native-operation` over private stdin/stdout. Exiting the tray leaves the independently launched gateway active. Linux systems without a status icon host can minimize the settings window and reopen from the launcher.
