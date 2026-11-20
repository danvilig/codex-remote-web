import AppKit
import CoreGraphics

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let html = output.appendingPathComponent("safari-control.html")
let screenshot = output.appendingPathComponent("safari-window.png")
try """
<!doctype html><meta charset="utf-8"><title>Safari capture control</title>
<body style="background:#145bd7;color:white;font:32px system-ui">
Safari capture control <input value="Native test">
<div style="display:flex;gap:16px;margin:16px">
<div style="width:120px;height:120px;background:#ff00ff"></div>
<div style="width:120px;height:120px;background:#00ff00"></div>
</div>
""".write(to: html, atomically: true, encoding: .utf8)

func run(_ executable: String, _ arguments: [String]) throws -> Int32 {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: executable)
    child.arguments = arguments
    try child.run()
    child.waitUntilExit()
    return child.terminationStatus
}

func markerPixels(_ bitmap: NSBitmapImageRep) -> (magenta: Int, green: Int) {
    var magenta = 0, green = 0
    for y in stride(from: 0, to: bitmap.pixelsHigh, by: 4) {
        for x in stride(from: 0, to: bitmap.pixelsWide, by: 4) {
            guard let pixel = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
            if pixel.redComponent > 0.85 && pixel.greenComponent < 0.15 && pixel.blueComponent > 0.85 { magenta += 1 }
            if pixel.redComponent < 0.15 && pixel.greenComponent > 0.85 && pixel.blueComponent < 0.15 { green += 1 }
        }
    }
    return (magenta, green)
}

let launchStatus = try run("/usr/bin/open", ["-a", "Safari", html.path])
guard launchStatus == 0 else { fatalError("Safari launch failed: \(launchStatus)") }
let display = CGMainDisplayID()
print("Display \(display): \(CGDisplayPixelsWide(display))x\(CGDisplayPixelsHigh(display)); screen capture preflight: \(CGPreflightScreenCaptureAccess())")

var passed = false
for attempt in 1...12 {
    Thread.sleep(forTimeInterval: 1)
    let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").map(\.processIdentifier))
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let target = windows.first { window in
        guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pids.contains(pid),
              window[kCGWindowLayer as String] as? Int == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: CGFloat] else { return false }
        return (bounds["Width"] ?? 0) >= 300 && (bounds["Height"] ?? 0) >= 200
    }
    guard let id = target?[kCGWindowNumber as String] as? UInt32 else {
        print("Attempt \(attempt): no visible Safari window; Safari pids: \(pids)")
        continue
    }
    let status = try run("/usr/sbin/screencapture", ["-x", "-o", "-l", String(id), screenshot.path])
    guard status == 0, let data = try? Data(contentsOf: screenshot), let bitmap = NSBitmapImageRep(data: data) else {
        print("Attempt \(attempt): Safari window \(id) capture failed (status \(status))")
        continue
    }
    let pixels = markerPixels(bitmap)
    print("Attempt \(attempt): Safari window \(id), \(bitmap.pixelsWide)x\(bitmap.pixelsHigh), magenta: \(pixels.magenta), green: \(pixels.green)")
    if pixels.magenta >= 100 && pixels.green >= 100 { passed = true; break }
}
if !passed { FileHandle.standardError.write(Data("Safari screenshot did not contain both fixture colors.\n".utf8)); exit(1) }
