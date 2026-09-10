import AppKit
import ApplicationServices

func stop(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]),
      pid > 0,
      let running = NSRunningApplication(processIdentifier: pid) else {
    stop("invalid or exited owned process")
}

guard AXIsProcessTrusted() else { stop("window adapter is not AX trusted") }
let command = CommandLine.arguments[2]
guard command == "resize" || command == "window" else {
    stop("unknown window adapter operation")
}

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2)
var windowValue: CFTypeRef?
let windowsStatus = AXUIElementCopyAttributeValue(
    app,
    kAXWindowsAttribute as CFString,
    &windowValue
)
guard windowsStatus == .success,
      let windows = windowValue as? [AXUIElement],
      windows.count == 1 else {
    stop("expected exactly one owned window")
}

let window = windows[0]
running.activate(options: [])
guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else {
    stop("owned window could not be raised")
}

if command == "resize" {
    var position = CGPoint(x: 0, y: 0)
    var size = CGSize(width: 1280, height: 760)
    guard let positionValue = AXValueCreate(.cgPoint, &position),
          AXUIElementSetAttributeValue(
              window,
              kAXPositionAttribute as CFString,
              positionValue
          ) == .success,
          let sizeValue = AXValueCreate(.cgSize, &size),
          AXUIElementSetAttributeValue(
              window,
              kAXSizeAttribute as CFString,
              sizeValue
          ) == .success else {
        stop("owned window could not be resized")
    }
    print("found")
    exit(0)
}

guard let info = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
) as? [[String: Any]] else {
    stop("window list unavailable")
}
let owned = info.filter {
    ($0[kCGWindowOwnerPID as String] as? Int32) == pid &&
        ($0[kCGWindowLayer as String] as? Int) == 0
}
guard owned.count == 1,
      let windowId = owned[0][kCGWindowNumber as String] as? Int else {
    stop("expected exactly one CoreGraphics owned window")
}

var sizeValue: CFTypeRef?
var positionValue: CFTypeRef?
guard AXUIElementCopyAttributeValue(
          window,
          kAXSizeAttribute as CFString,
          &sizeValue
      ) == .success,
      AXUIElementCopyAttributeValue(
          window,
          kAXPositionAttribute as CFString,
          &positionValue
      ) == .success,
      let sizeAttribute = sizeValue,
      let positionAttribute = positionValue,
      CFGetTypeID(sizeAttribute) == AXValueGetTypeID(),
      CFGetTypeID(positionAttribute) == AXValueGetTypeID() else {
    stop("owned window geometry unavailable")
}

var size = CGSize.zero
var position = CGPoint.zero
guard AXValueGetValue(sizeAttribute as! AXValue, .cgSize, &size),
      AXValueGetValue(positionAttribute as! AXValue, .cgPoint, &position) else {
    stop("owned window geometry is invalid")
}

print(
    "\(windowId), \(Int(size.width)), \(Int(size.height)), " +
        "\(Int(position.x)), \(Int(position.y)), \(running.isActive ? 1 : 0)"
)
