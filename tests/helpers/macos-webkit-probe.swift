// Test-only compositor reproducer. It never enters a distributed application.
import AppKit
import WebKit

final class Assets: NSObject, WKURLSchemeHandler {
    func webView(_ view: WKWebView, start task: WKURLSchemeTask) {
        let html = "<html><body style='background:#145bd7;color:white;font:40px system-ui'>System WebKit compositor probe<input value='Native test'></body></html>"
        let data = Data(html.utf8)
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data); task.didFinish()
    }
    func webView(_ view: WKWebView, stop task: WKURLSchemeTask) {}
}

@MainActor final class Probe: NSObject, NSApplicationDelegate {
    var window: NSWindow!, web: WKWebView!
    let assets = Assets()
    var mode = 0
    func applicationDidFinishLaunching(_ notification: Notification) { next() }
    func next() {
        if mode == 8 { NSApp.terminate(nil); return }
        window?.orderOut(nil)
        window = NSWindow(contentRect: NSRect(x: 80, y: 120, width: 760, height: 480), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "WebKit probe \(mode)"; window.isReleasedWhenClosed = false
        let host = NSView(frame: window.contentView!.bounds)
        host.wantsLayer = mode % 2 == 1
        let label = NSTextField(labelWithString: "Native AppKit label — probe \(mode)")
        label.frame = NSRect(x: 10, y: 430, width: 700, height: 40); host.addSubview(label)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = mode == 4 ? .default() : .nonPersistent()
        config.setURLSchemeHandler(assets, forURLScheme: "crw-probe")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 760, height: 420), configuration: config)
        web.autoresizingMask = [.width, .height]
        let load = {
            if self.mode < 2 { self.web.loadHTMLString("<body style='background:#145bd7;color:white;font:40px system-ui'>Inline WebKit compositor probe<input value='Native test'>", baseURL: nil) }
            else { self.web.load(URLRequest(url: URL(string: "crw-probe://settings/index.html")!)) }
        }
        if mode == 6 { load() }
        if mode == 5 { window.contentView = web }
        else { host.addSubview(web); window.contentView = host }
        if mode == 7 { host.layerUsesCoreImageFilters = true }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if mode != 6 { load() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            self.web.evaluateJavaScript("({text:document.body.innerText,focus:document.hasFocus(),width:innerWidth,height:innerHeight})") { value, error in
                print("PROBE", self.mode, "visible", self.window.isVisible, "occlusion", self.window.occlusionState.rawValue, "web", self.web.frame, "layer", self.web.layer != nil, "dom", value ?? "nil", "error", String(describing: error)); fflush(stdout)
                let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                capture.arguments = ["-x", CommandLine.arguments[1] + "/macos-webkit-probe-\(self.mode).png"]
                try! capture.run(); capture.waitUntilExit()
                self.mode += 1; self.next()
            }
        }
    }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared; app.setActivationPolicy(.regular)
    let delegate = Probe(); app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
