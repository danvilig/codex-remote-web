import AppKit
import WebKit
import Darwin

let resources = Bundle.main.resourceURL!
let installation = Bundle.main.executableURL!.path
let gateway = resources.appendingPathComponent("gateway/codex-remote-web")
let desktopURL = URL(string: "crw-desktop://settings/index.html")!
let environment = ProcessInfo.processInfo.environment.filter { $0.key != "DYLD_INSERT_LIBRARIES" }
let userHome = environment["HOME"] ?? NSHomeDirectory()
let privateRoot = URL(fileURLWithPath: userHome).appendingPathComponent(".config/codex-remote-web/desktop")

struct DesktopError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// Each helper completes a transaction in Bun, including SQLite locks and
// ownership checks. Neither arbitrary commands nor credentials reach WebKit.
func operation(_ action: String, _ body: Any = NSNull()) async throws -> [String: Any] {
    let data = try JSONSerialization.data(withJSONObject: ["action": action, "body": body])
    return try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global().async {
            do {
                let process = Process(), input = Pipe(), output = Pipe()
                process.executableURL = gateway
                process.arguments = ["native-operation", installation]
                process.environment = environment
                process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.standardError
                try process.run()
                // A blocked helper cannot hold the interface forever. The
                // backend retains durable recovery records for uncertain work.
                let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 125, execute: timeout)
                try input.fileHandleForWriting.write(contentsOf: data)
                try input.fileHandleForWriting.close()
                let reply = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit(); timeout.cancel()
                guard reply.count <= 1_048_576, process.terminationStatus == 0,
                      let result = try JSONSerialization.jsonObject(with: reply) as? [String: Any] else {
                    throw DesktopError(message: "Desktop helper could not complete")
                }
                guard result["ok"] as? Bool == true else {
                    throw DesktopError(message: result["error"] as? String ?? "Desktop operation failed")
                }
                continuation.resume(returning: result)
            } catch { continuation.resume(throwing: error) }
        }
    }
}

// Serve a fixed, bundled asset set. WebKit receives no file:// read grant to
// the gateway, HOME, account data, installation metadata or arbitrary paths.
final class DesktopAssets: NSObject, WKURLSchemeHandler {
    static let types = ["index.html": "text/html", "renderer.js": "application/javascript", "style.css": "text/css", "workspace.css": "text/css", "remote-access.css": "text/css", "desktop.css": "text/css"]
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == desktopURL.scheme, url.host == desktopURL.host,
              url.query == nil, url.fragment == nil, task.request.httpMethod == "GET",
              let type = Self.types[String(url.path.dropFirst())] else {
            task.didFailWithError(DesktopError(message: "Bundled asset unavailable")); return
        }
        do {
            let data = try Data(contentsOf: resources.appendingPathComponent("desktop" + url.path))
            task.didReceive(URLResponse(url: url, mimeType: type, expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

@MainActor
final class BackgroundSession: NSObject, NSApplicationDelegate {
    let process = Process(), lifetime = Pipe()
    func applicationDidFinishLaunching(_ notification: Notification) {
        process.executableURL = gateway; process.arguments = ["agent"]
        process.environment = environment.merging(["CODEX_WEBUI_DESKTOP_INSTALLATION": installation, "CODEX_WEBUI_DESKTOP_PIPE_PARENT": "1"]) { _, new in new }
        process.standardInput = lifetime
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.standardError
        process.terminationHandler = { child in DispatchQueue.main.async { NSApp.terminate(nil) } }
        do { try process.run() } catch { exit(1) }
    }
    func applicationWillTerminate(_ notification: Notification) { try? lifetime.fileHandleForWriting.close() }
}

@MainActor
final class DesktopApplication: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!, webView: WKWebView!
    @objc var statusItem: NSStatusItem!
    var locale = "en", uiLock: Int32 = -1
    var nativeStrings: [String: [String: String]] = [:]
    let assets = DesktopAssets()
    let backendActions: Set<String> = ["status", "dependencies", "config", "start", "stop", "restart", "setup", "language"]
    let nativeActions: Set<String> = ["chooseDirectory", "chooseCodex", "chooseCloudflared", "openWorkspace", "removeBackground", "cleanUninstall"]
    func t(_ value: String) -> String { nativeStrings[locale]?[value] ?? value }
    func language(_ preference: String) -> String {
        if preference == "zh" || preference == "zh-CN" { return "zh-CN" }
        if preference == "en" { return "en" }
        return (Locale.preferredLanguages.first { $0 == "en" || $0.hasPrefix("en-") || $0 == "zh" || $0.hasPrefix("zh-") } ?? "en").hasPrefix("zh") ? "zh-CN" : "en"
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            do {
                _ = try await operation("prepare")
                let path = privateRoot.appendingPathComponent("native-ui.lock").path
                uiLock = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
                var metadata = stat()
                guard uiLock >= 0, fstat(uiLock, &metadata) == 0, metadata.st_uid == getuid(),
                      metadata.st_nlink == 1, metadata.st_mode & S_IFMT == S_IFREG else { throw DesktopError(message: "Unsafe native application lock") }
                if flock(uiLock, LOCK_EX | LOCK_NB) != 0 {
                    for running in NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier!) where running.processIdentifier != getpid() && running.executableURL?.path == installation {
                        running.activate(options: [.activateAllWindows])
                        NSWorkspace.shared.open(Bundle.main.bundleURL)
                    }
                    NSApp.terminate(nil); return
                }
                let localization = try Data(contentsOf: resources.appendingPathComponent("native-localization.json"))
                nativeStrings = try JSONSerialization.jsonObject(with: localization) as? [String: [String: String]] ?? [:]
                try await ensureAgent()
                let state = try await operation("status")
                locale = language(((state["value"] as? [String: Any])?["config"] as? [String: Any])?["language"] as? String ?? "system")
                createWindow(); createMenus(); showSettings()
                if CommandLine.arguments.contains("--open-workspace") { _ = try await perform("openWorkspace", NSNull()) }
            } catch { showError(error); NSApp.terminate(nil) }
        }
    }
    func ensureAgent() async throws {
        if (try? await operation("status")) != nil { return }
        let process = Process()
        process.executableURL = Bundle.main.executableURL; process.arguments = ["--background-agent"]
        process.environment = environment
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.standardError
        try process.run()
        for _ in 0..<100 {
            if (try? await operation("status")) != nil { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw DesktopError(message: "Background agent could not start. Check installation and private directory permissions.")
    }
    func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(assets, forURLScheme: desktopURL.scheme!)
        let controller = configuration.userContentController
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "desktop")
        controller.addUserScript(WKUserScript(source: "Object.defineProperty(window, 'desktop', {value: Object.freeze({invoke: (action, body) => window.webkit.messageHandlers.desktop.postMessage({action, body: body ?? null})}), writable: false, configurable: false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Codex Remote Web"; window.minSize = NSSize(width: 660, height: 540)
        window.isReleasedWhenClosed = false; window.delegate = self
        window.contentView = webView; window.center()
        webView.load(URLRequest(url: desktopURL))
    }
    func showSettings() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showSettings(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationWillTerminate(_ notification: Notification) { if uiLock >= 0 { close(uiLock) } }
    func showError(_ error: Error) { let alert = NSAlert(); alert.messageText = "Codex Remote Web"; alert.informativeText = error.localizedDescription; alert.runModal() }

    func item(_ title: String, _ action: Selector?, _ key: String = "") -> NSMenuItem {
        let result = NSMenuItem(title: t(title), action: action, keyEquivalent: key)
        result.target = self; return result
    }
    func gatewayMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(item("Settings", #selector(settings))); menu.addItem(item("Open workspace", #selector(workspace)))
        menu.addItem(.separator()); menu.addItem(item("Start gateway", #selector(start))); menu.addItem(item("Stop gateway", #selector(stop)))
        menu.addItem(.separator()); menu.addItem(item("Quit tray (gateway continues)", #selector(quit), "q"))
        return menu
    }
    func createMenus() {
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            let image = NSImage(contentsOf: resources.appendingPathComponent("desktop/tray.png"))
            image?.isTemplate = true; image?.size = NSSize(width: 20, height: 20)
            statusItem.button?.image = image; statusItem.button?.toolTip = "Codex Remote Web"
        }
        statusItem.menu = gatewayMenu()
        let main = NSMenu()
        let application = NSMenuItem(title: "Codex Remote Web", action: nil, keyEquivalent: "")
        application.submenu = gatewayMenu()
        let hide = NSMenuItem(title: t("Hide Codex Remote Web"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        application.submenu!.insertItem(hide, at: 6)
        main.addItem(application)
        for (title, commands) in [
            ("Edit", [("Undo", Selector(("undo:")), "z"), ("Redo", Selector(("redo:")), "Z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")]),
            ("View", [("Toggle Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "")]),
            ("Window", [("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"), ("Zoom", #selector(NSWindow.performZoom(_:)), ""), ("Close", #selector(NSWindow.performClose(_:)), "w")])
        ] {
            let top = NSMenuItem(title: t(title), action: nil, keyEquivalent: ""), menu = NSMenu(title: t(title))
            for (label, selector, key) in commands { menu.addItem(NSMenuItem(title: t(label), action: selector, keyEquivalent: key)) }
            top.submenu = menu; main.addItem(top)
            if title == "Window" { NSApp.windowsMenu = menu }
        }
        NSApp.mainMenu = main
    }
    @objc func settings() { showSettings() }
    @objc func workspace() { run("openWorkspace") }
    @objc func start() { run("start") }
    @objc func stop() { run("stop") }
    @objc func quit() { NSApp.terminate(nil) }
    func run(_ action: String) { Task { do { _ = try await perform(action, NSNull()) } catch { showError(error) } } }
    func confirmation(_ action: String) -> Bool {
        let clean = action == "cleanUninstall", alert = NSAlert()
        alert.alertStyle = clean ? .warning : .informational
        alert.messageText = t(clean ? "Clean up and quit?" : "Stop and remove the background component?")
        alert.informativeText = clean ? t("Remove app settings, caches, logs and saved management tokens. Projects and your Codex account are preserved.") + "\n" + t("The application will move to the Trash.") : t("Your projects, credentials and remote deployment records will be preserved.")
        alert.addButton(withTitle: t("Cancel")); alert.addButton(withTitle: t(clean ? "Clean up" : "Remove"))
        alert.buttons[0].keyEquivalent = "\r"; alert.buttons[1].keyEquivalent = ""
        return alert.runModal() == .alertSecondButtonReturn
    }
    func external(_ url: URL) {
        guard url.user == nil, url.password == nil, url.scheme == "https" || (url.scheme == "http" && url.host == "127.0.0.1") else { return }
        NSWorkspace.shared.open(url)
    }
    func perform(_ action: String, _ body: Any) async throws -> [String: Any] {
        guard backendActions.contains(action) || nativeActions.contains(action) else { throw DesktopError(message: "Unsupported desktop operation") }
        if action.hasPrefix("choose") {
            let panel = NSOpenPanel(); panel.canChooseDirectories = action == "chooseDirectory"; panel.canChooseFiles = !panel.canChooseDirectories; panel.allowsMultipleSelection = false
            let response = await panel.beginSheetModal(for: window)
            return ["ok": true, "value": response == .OK ? (panel.url?.path as Any? ?? NSNull()) : NSNull()]
        }
        if action == "openWorkspace" {
            let reply = try await operation("status")
            if let state = reply["value"] as? [String: Any], let address = state["url"] as? String, let url = URL(string: address) { external(url) }
            return ["ok": true, "value": NSNull()]
        }
        if action == "removeBackground" || action == "cleanUninstall" {
            guard confirmation(action) else { return ["ok": true, "value": NSNull()] }
            let result = try await operation(action)
            if action == "cleanUninstall" {
                webView.stopLoading(); window.orderOut(nil)
                try FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            return result
        }
        var reply = try await operation(action, body)
        if action == "config" || action == "language" {
            locale = language(((reply["value"] as? [String: Any])?["config"] as? [String: Any])?["language"] as? String ?? "system")
            createMenus()
        }
        if action == "status", var state = reply["value"] as? [String: Any] { state["systemLocale"] = language("system"); reply["value"] = state }
        return reply
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.webView === webView, message.frameInfo.isMainFrame, message.frameInfo.request.url == desktopURL,
              let payload = message.body as? [String: Any], let action = payload["action"] as? String,
              let bytes = try? JSONSerialization.data(withJSONObject: payload), bytes.count <= 16384 else {
            replyHandler(nil, "Untrusted desktop request"); return
        }
        Task {
            do { replyHandler(try await perform(action, payload["body"] ?? NSNull()), nil) }
            catch { replyHandler(["ok": false, "error": error.localizedDescription], nil) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url == desktopURL && navigationAction.targetFrame?.isMainFrame == true { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url { external(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { external(url) }; return nil
    }
}

// AppKit starts on the process main thread. Make that actor boundary explicit
// for both the macOS 15 and current SDK compilers.
MainActor.assumeIsolated {
    let background = CommandLine.arguments.contains("--background-agent")
    let app = NSApplication.shared
    app.setActivationPolicy(background ? .prohibited : .regular)
    let delegate: NSApplicationDelegate = background ? BackgroundSession() : DesktopApplication()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
