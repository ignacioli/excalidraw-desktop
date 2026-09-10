import AppKit
import ApplicationServices

// External AX client: never evaluates JavaScript or injects application state.
func stop(_ message: String) -> Never { print(message); exit(2) }
guard CommandLine.arguments.count >= 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let running = NSRunningApplication(processIdentifier: pid) else {
    stop("invalid or exited owned process")
}
guard AXIsProcessTrusted() else { stop("AX client is not trusted") }
let command = CommandLine.arguments[2]
let target = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2)
func read(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(node, key as CFString, &value)
    if result == .success { return value }
    if result == .noValue || result == .attributeUnsupported { return nil }
    stop("AX read failed: \(key) code=\(result.rawValue)")
}
func perform(_ node: AXUIElement, _ action: String) {
    let result = AXUIElementPerformAction(node, action as CFString)
    if result != .success { stop("AX action failed: \(action) code=\(result.rawValue)") }
}
if command == "query" || command == "press" {
    var matches: [AXUIElement] = []
    var visited = 0
    func walk(_ node: AXUIElement, _ depth: Int) {
        guard depth < 40 && visited < 10000 else { stop("AX traversal limit exceeded") }
        visited += 1
        let title = read(node, kAXTitleAttribute) as? String ?? ""
        let description = read(node, kAXDescriptionAttribute) as? String ?? ""
        let value = read(node, kAXValueAttribute) as? String ?? ""
        if title == target || description == target || (command == "query" && value == target) {
            if command == "query" { matches.append(node) }
            else {
                var names: CFArray?
                let status = AXUIElementCopyActionNames(node, &names)
                if status == .success && (names as? [String] ?? []).contains(kAXPressAction) { matches.append(node) }
            }
        }
        if let children = read(node, kAXChildrenAttribute) as? [AXUIElement] {
            for child in children { walk(child, depth + 1) }
        }
    }
    walk(app, 0)
    if matches.isEmpty { print("not-found"); exit(3) }
    if command == "press" {
        guard matches.count == 1 else { stop("ambiguous AXPress target: \(matches.count)") }
        running.activate(options: [])
        perform(matches[0], kAXPressAction)
    }
    print("found")
} else if command == "raise" || command == "resize" || command == "window" {
    guard let windows = read(app, kAXWindowsAttribute) as? [AXUIElement],
          windows.count == 1 else { stop("expected exactly one owned window") }
    running.activate(options: [])
    perform(windows[0], kAXRaiseAction)
    if command == "resize" {
        var size = CGSize(width: 1280, height: 760)
        let value = AXValueCreate(.cgSize, &size)!
        let status = AXUIElementSetAttributeValue(windows[0], kAXSizeAttribute as CFString, value)
        if status != .success { stop("AX resize failed: \(status.rawValue)") }
    }
    if command == "window" {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { stop("window list unavailable") }
        let owned = info.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        guard owned.count == 1, let id = owned[0][kCGWindowNumber as String] as? Int,
              let sizeValue = read(windows[0], kAXSizeAttribute),
              let positionValue = read(windows[0], kAXPositionAttribute) else { stop("owned window identity unavailable") }
        var size = CGSize.zero, point = CGPoint.zero
        guard AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
              AXValueGetValue(positionValue as! AXValue, .cgPoint, &point) else { stop("window geometry unavailable") }
        print("\(id), \(Int(size.width)), \(Int(size.height)), \(Int(point.x)), \(Int(point.y)), \(running.isActive ? 1 : 0)")
    } else { print("found") }
} else { stop("unknown AX operation") }
