import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import Synchronization

// Atomic<Bool> is lock-free on supported Mac architectures. Initialize it before
// installing POSIX handlers; handlers only perform a relaxed atomic store, with
// no Foundation, allocation, logging, Objective-C messaging, or async work.
private let nativeStopRequested=Atomic<Bool>(false)
private func nativeTerminationSignal(_ number:Int32) { nativeStopRequested.store(true,ordering:.relaxed) }
func checkNativeTermination() throws {
    if nativeStopRequested.load(ordering:.relaxed) { throw DriverFailure("STOPPING") }
}
func nativeTerminationRequested() -> Bool { nativeStopRequested.load(ordering:.relaxed) }
func installNativeTerminationHandlers() {
    _ = nativeStopRequested.load(ordering:.relaxed)
    var action=sigaction()
    action.__sigaction_u.__sa_handler=nativeTerminationSignal
    sigemptyset(&action.sa_mask)
    action.sa_flags=0 // Interrupt an idle blocking stdin read instead of restarting it.
    _ = sigaction(SIGTERM,&action,nil); _ = sigaction(SIGINT,&action,nil)
}

// A short interruptible poll lets an idle helper honor a stop signal even when
// Darwin delivers that signal on a different runtime thread. Buffer size is an
// I/O chunk, never a maximum request/line length.
struct NativeProtocolLineReader {
    private var buffered=Data()
    private var ended=false
    mutating func nextLine() -> String? {
        while !nativeTerminationRequested() {
            if let newline=buffered.firstIndex(of:10) {
                let line=buffered[..<newline]
                let result=String(decoding:line,as:UTF8.self)
                buffered.removeSubrange(...newline)
                return result
            }
            if ended {
                guard !buffered.isEmpty else { return nil }
                let result=String(decoding:buffered,as:UTF8.self); buffered.removeAll(); return result
            }
            var descriptor=pollfd(fd:STDIN_FILENO,events:Int16(POLLIN),revents:0)
            let ready=poll(&descriptor,1,100)
            if ready < 0 { if errno == EINTR { continue }; return nil }
            if ready == 0 { continue }
            var bytes=[UInt8](repeating:0,count:65536)
            let count=Darwin.read(STDIN_FILENO,&bytes,bytes.count)
            if count > 0 { buffered.append(contentsOf:bytes.prefix(count)) }
            else if count == 0 { ended=true }
            else if errno != EINTR && errno != EAGAIN { return nil }
        }
        return nil
    }
}

// A new observation naturally supersedes the prior state of that same app.
// Independent apps keep their latest state; there is no age/count quota or TTL.
struct LatestObservationStore<Value> {
    private var values:[String:(pid_t,Value)]=[:]
    subscript(_ id:String) -> Value? { values[id]?.1 }
    mutating func record(id:String,owner:pid_t,value:Value) {
        values=values.filter { $0.value.0 != owner }
        values[id]=(owner,value)
    }
    mutating func prune(liveOwners:Set<pid_t>) { values=values.filter { liveOwners.contains($0.value.0) } }
}

// A persistent, one-request-per-line adapter. Stdout is reserved for protocol replies.
struct DriverFailure: Error { let code: String; init(_ code: String) { self.code = code } }
// Kept independent of attribute reads so absence/difference behavior is testable
// without consulting a user's desktop or requiring Accessibility permission.
func requireMatchingAXFocus(expected: AXUIElement?, current: AXUIElement?, allowBothAbsent: Bool) throws {
    switch (expected,current) {
    case (nil,nil): if !allowBothAbsent { throw DriverFailure("FOCUS_CHANGED") }
    case (let expected?,let current?): if !CFEqual(expected,current) { throw DriverFailure("FOCUS_CHANGED") }
    default: throw DriverFailure("FOCUS_CHANGED")
    }
}
func postPairedKeyInput(parentCheck: () throws -> Void, down: () -> Void, up: () -> Void, cleanup: () -> Void) throws {
    try parentCheck(); down()
    do { try parentCheck(); up() }
    catch {
        // A parent dying after key-down must not leave a pressed key behind.
        // Cleanup emits only the corresponding release, never another key-down.
        cleanup(); throw error
    }
}
// Match captured windows using metadata only; never choose another owner or an
// arbitrary window when the observed identity is missing or ambiguous.
struct CaptureWindowIdentity {
    let owner: pid_t?
    let bounds: CGRect
    let title: String
}
func windowCaptureTitleMatches(_ axTitle: String, _ captureTitle: String, applicationName: String?) -> Bool {
    if axTitle == captureTitle { return true }
    guard let name=applicationName, !name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { return false }
    let suffix=" - "+name
    func normalized(_ title: String) -> String {
        let prefix: String
        if title.hasSuffix(suffix) {
            prefix=String(title.dropLast(suffix.count))
        } else if name == "Google Chrome", let marker=title.range(of:suffix+" - ",options:.backwards),
                  !title[marker.upperBound...].trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
            // Observed Chrome AX titles append a profile name after the app name;
            // ScreenCaptureKit omits both. Only normalize this known Chrome shape.
            // The caller still requires exact PID, geometry, and a unique match.
            prefix=String(title[..<marker.lowerBound])
        } else { return title }
        // An app name alone is not evidence for an untitled window.
        return prefix.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? title : prefix
    }
    // Preserve a literal app/profile-like fragment that belongs to the document
    // title by comparing each undecorated candidate with the other's raw title.
    let axDocument=normalized(axTitle), captureDocument=normalized(captureTitle)
    return axDocument == captureTitle || axTitle == captureDocument || axDocument == captureDocument
}
func requireUniqueCaptureWindow(_ candidates: [CaptureWindowIdentity], owner: pid_t, bounds: CGRect, title: String, applicationName: String?) throws -> Int {
    let matches=candidates.indices.filter { index in
        let candidate=candidates[index]
        return candidate.owner == owner && candidate.bounds == bounds && windowCaptureTitleMatches(title,candidate.title,applicationName:applicationName)
    }
    guard matches.count == 1, let index=matches.first else { throw DriverFailure("WINDOW_NOT_FOUND") }
    return index
}
struct Identity: Equatable {
    let role: String
    let label: String
    let value: String?
    let bounds: CGRect?
}
struct NodeSnapshot {
    let element: AXUIElement; let identity: Identity; let menu:Bool
    init(element: AXUIElement, identity: Identity, menu:Bool = false) { self.element=element; self.identity=identity; self.menu=menu }
}
struct WindowSnapshot { let id: String; let element: AXUIElement; let identity: Identity }
struct Observation {
    let pid: pid_t
    let launched: Date?
    let appElement: AXUIElement
    let window: WindowSnapshot?
    let nodes: [String: NodeSnapshot]
    let focused: NodeSnapshot?
    var imageBounds: CGRect?
    var imageSize: CGSize?
}

@MainActor final class DesktopDriver {
    init() {
        // Standalone command-line tools have no NSApplicationMain bootstrap.
        // shared initializes the public AppKit display/WindowServer connection
        // required by ScreenCaptureKit's CG-backed window/image operations.
        let application=NSApplication.shared
        _ = application.setActivationPolicy(.prohibited)
    }
    private var observations=LatestObservationStore<Observation>()
    private var windowIdentifiers: [pid_t: [(AXUIElement, String)]] = [:]
    private func checkParent() throws {
        try checkNativeTermination()
        guard let expected = ProcessInfo.processInfo.environment["JEV_DESKTOP_PARENT_PID"] else { return }
        guard let pid = Int32(expected), pid > 0, getppid() == pid, kill(pid, 0) == 0 || errno == EPERM else { throw DriverFailure("PARENT_GONE") }
    }

    private func retireTerminatedApps() {
        let running=Set(NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }.map(\.processIdentifier))
        observations.prune(liveOwners:running)
        windowIdentifiers=windowIdentifiers.filter { running.contains($0.key) }
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }
    private func string(_ element: AXUIElement, _ name: String) -> String? {
        guard let value = attribute(element, name) else { return nil }
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        return nil
    }
    private func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
        guard let result = attribute(element, name) else { return [] }
        if CFGetTypeID(result) == CFArrayGetTypeID() { return (result as? [AXUIElement]) ?? [] }
        if CFGetTypeID(result) == AXUIElementGetTypeID() { return [unsafeBitCast(result, to: AXUIElement.self)] }
        return []
    }
    private func bounds(_ element: AXUIElement) -> CGRect? {
        guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero; var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    private func identity(_ element: AXUIElement) -> Identity {
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute]
            .compactMap { string(element, $0) }.first(where: { !$0.isEmpty }) ?? ""
        return Identity(role: string(element, kAXRoleAttribute) ?? "AXUnknown", label: label,
                        value: string(element, kAXValueAttribute), bounds: bounds(element))
    }
    private func rectJSON(_ r: CGRect) -> [String: Double] { ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
    private func requireAX() throws { if !AXIsProcessTrusted() { throw DriverFailure("PERMISSION_REQUIRED") } }
    private func resolve(_ input: Any?) throws -> NSRunningApplication {
        guard let input else { throw DriverFailure("INVALID_PARAMS") }
        if let number = input as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue > 0,
           number.doubleValue == Double(number.int32Value) {
            guard let app = NSRunningApplication(processIdentifier:number.int32Value), !app.isTerminated else { throw DriverFailure("APP_NOT_RUNNING") }
            return app
        }
        guard let name = input as? String, !name.isEmpty else { throw DriverFailure("INVALID_PARAMS") }
        let matches = NSWorkspace.shared.runningApplications.filter { app in
            app.bundleIdentifier == name || app.localizedName == name || app.bundleURL?.path == name
        }
        guard !matches.isEmpty else { throw DriverFailure("APP_NOT_RUNNING") }
        guard matches.count == 1 else { throw DriverFailure("AMBIGUOUS_APP") }
        return matches[0]
    }
    private func appJSON(_ app: NSRunningApplication) -> [String: Any] {
        var result: [String:Any] = ["pid":app.processIdentifier,"name":app.localizedName ?? ""]
        if let bundle = app.bundleIdentifier { result["bundle_id"] = bundle }
        return result
    }
    private func appURL(_ input: Any?) throws -> URL {
        if input is NSNumber, let running = try? resolve(input), let url = running.bundleURL { return url }
        guard let name = input as? String, !name.isEmpty else { throw DriverFailure("INVALID_PARAMS") }
        if name.hasPrefix("/") {
            let url = URL(fileURLWithPath:name).standardizedFileURL
            guard url.pathExtension.lowercased() == "app", FileManager.default.fileExists(atPath:url.path) else { throw DriverFailure("APP_NOT_FOUND") }
            return url
        }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier:name) { return url }
        if let running = try? resolve(name), let url = running.bundleURL { return url }
        // LaunchServices resolves arbitrary registered app names, including custom locations.
        if let path = NSWorkspace.shared.fullPath(forApplication:name) { return URL(fileURLWithPath:path) }
        for base in ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory()+"/Applications"] {
            let candidate = URL(fileURLWithPath:base).appendingPathComponent(name.hasSuffix(".app") ? name : name+".app")
            if FileManager.default.fileExists(atPath:candidate.path) { return candidate }
        }
        throw DriverFailure("APP_NOT_FOUND")
    }
    private func windowSnapshots(_ appElement: AXUIElement, pid: pid_t) -> [WindowSnapshot] {
        let current = elements(appElement, kAXWindowsAttribute)
        let previous = windowIdentifiers[pid] ?? []
        let next = current.map { window -> (AXUIElement, String) in
            (window, previous.first(where: { CFEqual($0.0,window) })?.1 ?? UUID().uuidString)
        }
        windowIdentifiers[pid] = next
        return next.map { WindowSnapshot(id:$0.1,element:$0.0,identity:identity($0.0)) }
    }
    private func windowJSON(_ window: WindowSnapshot) -> [String:Any] {
        var result: [String:Any] = ["window_id":window.id,"title":window.identity.label]
        if let b = window.identity.bounds { result["bounds"] = rectJSON(b) }
        return result
    }
    private func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return names as? [String] ?? []
    }
    private func settable(_ element: AXUIElement, _ name: String) -> Bool {
        var value = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
    }
    private func checkedObservation(_ p: [String:Any]) throws -> (String, Observation, NSRunningApplication) {
        guard let id = p["observation_id"] as? String, let observation = observations[id] else { throw DriverFailure("STALE_OBSERVATION") }
        let app = try resolve(p["app"])
        guard app.processIdentifier == observation.pid, app.launchDate == observation.launched else { throw DriverFailure("STALE_OBSERVATION") }
        try requireAX()
        if let window = observation.window {
            guard elements(observation.appElement, kAXWindowsAttribute).contains(where:{ CFEqual($0, window.element) }), identity(window.element) == window.identity else { throw DriverFailure("STALE_OBSERVATION") }
        }
        return (id, observation, app)
    }
    private func checkedNode(_ p: [String:Any], _ observation: Observation, required: Bool = true) throws -> NodeSnapshot? {
        guard let id = p["element_id"] as? String else {
            if required { throw DriverFailure("INVALID_PARAMS") }; return nil
        }
        guard let node = observation.nodes[id], identity(node.element) == node.identity else { throw DriverFailure("STALE_OBSERVATION") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(node.element, &pid) == .success, pid == observation.pid else { throw DriverFailure("STALE_OBSERVATION") }
        guard (attribute(node.element, kAXEnabledAttribute) as? NSNumber)?.boolValue != false else { throw DriverFailure("ELEMENT_DISABLED") }
        return node
    }
    private func activate(_ app: NSRunningApplication, _ observation: Observation) async throws {
        try checkParent()
        guard app.activate(options: [.activateAllWindows]) else { throw DriverFailure("ACTIVATION_FAILED") }
        if let window = observation.window {
            try checkParent()
            _ = AXUIElementPerformAction(window.element, kAXRaiseAction as CFString)
            if settable(window.element,kAXMainAttribute) { try checkParent(); _ = AXUIElementSetAttributeValue(window.element,kAXMainAttribute as CFString,kCFBooleanTrue) }
            if settable(window.element,kAXFocusedAttribute) { try checkParent(); _ = AXUIElementSetAttributeValue(window.element,kAXFocusedAttribute as CFString,kCFBooleanTrue) }
        }
        // Wait only for actual foreground ownership, never assume activate() means focus settled.
        for _ in 0..<100 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
                if let window = observation.window {
                    guard identity(window.element) == window.identity else { throw DriverFailure("STALE_OBSERVATION") }
                }
                let focused = elements(observation.appElement,kAXFocusedWindowAttribute).first
                do { try requireMatchingAXFocus(expected:observation.window?.element,current:focused,allowBothAbsent:true) }
                catch { try await Task.sleep(nanoseconds:20_000_000); continue }
                try checkParent()
                return
            }
            try await Task.sleep(nanoseconds:20_000_000)
        }
        throw DriverFailure("ACTIVATION_FAILED")
    }
    private func ensureFrontmost(_ observation: Observation) throws {
        try checkParent()
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == observation.pid else { throw DriverFailure("FOCUS_CHANGED") }
        if let window = observation.window {
            // The initial snapshot is checked strictly before dispatch. During a single
            // ongoing input, its own edits/drags may change title, value, and geometry.
            guard elements(observation.appElement,kAXWindowsAttribute).contains(where:{CFEqual($0,window.element)}),
                  string(window.element,kAXRoleAttribute) == window.identity.role else { throw DriverFailure("STALE_OBSERVATION") }
        }
        try requireMatchingAXFocus(expected:observation.window?.element,current:elements(observation.appElement,kAXFocusedWindowAttribute).first,allowBothAbsent:true)
    }
    private func checkFocus(_ observation: Observation, expected: NodeSnapshot?, strict: Bool = false, allowBothAbsent: Bool = false) throws {
        let current = elements(observation.appElement,kAXFocusedUIElementAttribute).first
        try requireMatchingAXFocus(expected:expected?.element,current:current,allowBothAbsent:allowBothAbsent)
        if strict, let current, let expected, identity(current) != expected.identity { throw DriverFailure("STALE_OBSERVATION") }
    }
    private func visibleCenter(_ node: NodeSnapshot?, _ observation: Observation) throws -> CGPoint {
        if let node, node.menu, let bounds=node.identity.bounds, node.identity.role != kAXMenuBarRole { return CGPoint(x:bounds.midX,y:bounds.midY) }
        guard let windowBounds = observation.window?.identity.bounds else { throw DriverFailure("INVALID_COORDINATES") }
        let visible = (node?.identity.bounds ?? windowBounds).intersection(windowBounds)
        guard !visible.isNull, !visible.isEmpty else { throw DriverFailure("INVALID_COORDINATES") }
        return CGPoint(x:visible.midX,y:visible.midY)
    }
    private func onScreen(_ point: CGPoint) -> Bool {
        var count:UInt32=0
        guard CGGetActiveDisplayList(0,nil,&count) == .success else { return false }
        var displays=[CGDirectDisplayID](repeating:0,count:Int(count))
        guard CGGetActiveDisplayList(count,&displays,&count) == .success else { return false }
        return displays.prefix(Int(count)).contains { CGDisplayBounds($0).contains(point) }
    }
    private func point(_ x: Any?, _ y: Any?, space: String, observation: Observation, inside: Bool = true) throws -> CGPoint {
        guard let x = x as? NSNumber, let y = y as? NSNumber, x.doubleValue.isFinite, y.doubleValue.isFinite,
              CFGetTypeID(x) != CFBooleanGetTypeID(), CFGetTypeID(y) != CFBooleanGetTypeID() else { throw DriverFailure("INVALID_PARAMS") }
        var p = CGPoint(x:x.doubleValue, y:y.doubleValue)
        if space == "screenshot" {
            guard let b = observation.imageBounds, let size = observation.imageSize, size.width > 0, size.height > 0,
                  p.x >= 0, p.y >= 0, p.x < size.width, p.y < size.height else { throw DriverFailure("INVALID_COORDINATES") }
            p = CGPoint(x:b.minX+p.x*b.width/size.width,y:b.minY+p.y*b.height/size.height)
        } else if space != "screen" { throw DriverFailure("INVALID_PARAMS") }
        if inside {
            let inWindow = observation.window?.identity.bounds?.contains(p) == true
            let inMenu = observation.nodes.values.contains { $0.menu && $0.identity.role != kAXMenuBarRole && $0.identity.bounds?.contains(p) == true }
            guard inWindow || inMenu else { throw DriverFailure("INVALID_COORDINATES") }
        }
        guard onScreen(p) else { throw DriverFailure("INVALID_COORDINATES") }
        return p
    }
    private func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, count: Int = 1) throws {
        try checkParent()
        guard let event = CGEvent(mouseEventSource:nil, mouseType:type, mouseCursorPosition:point, mouseButton:button) else { throw DriverFailure("INPUT_FAILED") }
        event.setIntegerValueField(.mouseEventClickState, value:Int64(count)); event.post(tap:.cghidEventTap)
    }
    private func releaseMouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton) {
        // Release-only cleanup is allowed after owner death; never initiates an input.
        guard [.leftMouseUp,.rightMouseUp,.otherMouseUp].contains(type),
              let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:point,mouseButton:button) else { return }
        event.post(tap:.cghidEventTap)
    }
    private func keySpec(_ text: String) throws -> (CGKeyCode, CGEventFlags) {
        let aliases: [String:CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"enter":36,"return":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"`":50,"backspace":51,"delete":51,"escape":53,"esc":53,"f17":64,"f18":79,"f19":80,"f20":90,"f5":96,"f6":97,"f7":98,"f3":99,"f8":100,"f9":101,"f11":103,"f13":105,"f16":106,"f14":107,"f10":109,"f12":111,"f15":113,"home":115,"pageup":116,"forwarddelete":117,"end":119,"f4":118,"f2":120,"pagedown":121,"f1":122,"left":123,"right":124,"down":125,"up":126]
        var parts = text.lowercased().split(separator:"+").map { $0.trimmingCharacters(in:.whitespaces) }
        guard let key = parts.popLast(), let code = aliases[key] else { throw DriverFailure("UNSUPPORTED_KEY") }
        var flags: CGEventFlags = []
        for part in parts {
            switch part { case "cmd","command","super","meta":flags.insert(.maskCommand)
            case "ctrl","control":flags.insert(.maskControl)
            case "alt","option":flags.insert(.maskAlternate)
            case "shift":flags.insert(.maskShift)
            default:throw DriverFailure("UNSUPPORTED_KEY") }
        }
        return (code,flags)
    }
    private func keyEvent(_ code: CGKeyCode, _ flags: CGEventFlags, unicode: [UniChar]? = nil) throws {
        try checkParent()
        guard let down = CGEvent(keyboardEventSource:nil, virtualKey:code,keyDown:true), let up = CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false) else { throw DriverFailure("INPUT_FAILED") }
        down.flags=flags; up.flags=flags
        if let unicode { unicode.withUnsafeBufferPointer { chars in
            if let base = chars.baseAddress { down.keyboardSetUnicodeString(stringLength:unicode.count,unicodeString:base); up.keyboardSetUnicodeString(stringLength:unicode.count,unicodeString:base) }
        } }
        try postPairedKeyInput(parentCheck:checkParent,down:{down.post(tap:.cghidEventTap)},up:{up.post(tap:.cghidEventTap)},cleanup:{up.flags=[]; up.post(tap:.cghidEventTap)})
    }
    private func capture(_ observation: inout Observation, fullDisplay:Bool = false) async throws -> [String:Any] {
        guard CGPreflightScreenCaptureAccess() else { throw DriverFailure("PERMISSION_REQUIRED") }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false) }
        catch { throw DriverFailure("SCREEN_CAPTURE_FAILED") }
        let filter:SCContentFilter; let b:CGRect
        var metadata:[String:Any]=[:]
        if fullDisplay {
            let display:SCDisplay?
            if let windowBounds=observation.window?.identity.bounds {
                display=content.displays.max { first,second in
                    let a=CGDisplayBounds(first.displayID).intersection(windowBounds)
                    let c=CGDisplayBounds(second.displayID).intersection(windowBounds)
                    return (a.isNull ? 0 : a.width*a.height) < (c.isNull ? 0 : c.width*c.height)
                }
            } else { display=content.displays.first(where:{$0.displayID == CGMainDisplayID()}) ?? content.displays.first }
            guard let display else { throw DriverFailure("DISPLAY_NOT_FOUND") }
            b=CGDisplayBounds(display.displayID)
            filter=SCContentFilter(display:display,excludingWindows:[])
            metadata=["capture_scope":"display","display_id":display.displayID]
        } else {
            guard let window=observation.window, let windowBounds=window.identity.bounds else { throw DriverFailure("WINDOW_NOT_FOUND") }
            b=windowBounds
            let identities=content.windows.map { CaptureWindowIdentity(owner:$0.owningApplication?.processID,bounds:$0.frame,title:$0.title ?? "") }
            let targetIndex=try requireUniqueCaptureWindow(identities,owner:observation.pid,bounds:b,title:window.identity.label,applicationName:NSRunningApplication(processIdentifier:observation.pid)?.localizedName)
            let target=content.windows[targetIndex]
            filter=SCContentFilter(desktopIndependentWindow:target)
            metadata=["capture_scope":"window","window_server_id":target.windowID]
        }
        let config=SCStreamConfiguration()
        let scale=Double(filter.pointPixelScale)
        config.width=Int((b.width*scale).rounded()); config.height=Int((b.height*scale).rounded())
        config.showsCursor=false; config.ignoreShadowsSingleWindow=true
        let captured:CGImage
        do { captured=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config) }
        catch { throw DriverFailure("SCREEN_CAPTURE_FAILED") }
        if let window=observation.window, identity(window.element) != window.identity { throw DriverFailure("STALE_OBSERVATION") }
        let data=NSMutableData()
        guard let destination=CGImageDestinationCreateWithData(data,UTType.png.identifier as CFString,1,nil) else { throw DriverFailure("SCREEN_CAPTURE_FAILED") }
        CGImageDestinationAddImage(destination,captured,nil)
        guard CGImageDestinationFinalize(destination) else { throw DriverFailure("SCREEN_CAPTURE_FAILED") }
        observation.imageBounds=b; observation.imageSize=CGSize(width:captured.width,height:captured.height)
        metadata.merge(["data":data.base64EncodedString(),"mimeType":"image/png","width":captured.width,"height":captured.height,
                "coordinate_space":"screenshot","screen_bounds":rectJSON(b),"scale_x":Double(captured.width)/b.width,"scale_y":Double(captured.height)/b.height,"screen_coordinate_system":"quartz_global_points_top_left"],uniquingKeysWith:{$1})
        return metadata
    }

    func handle(_ method: String, _ p: [String:Any]) async throws -> [String:Any] {
        switch method {
        case "status": return ["platform":"macos","accessibility":AXIsProcessTrusted(),"screen_capture":CGPreflightScreenCaptureAccess(),"driver":"native-public-api","input_requires_observation":true,"app_inventory_scope":"running","screenshot_scopes":["window","display"]]
        case "list_apps": return ["scope":"running","apps":NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }.map(appJSON)]
        case "launch_app", "open_document":
            try checkParent()
            let url=try appURL(p["app"])
            let configuration=NSWorkspace.OpenConfiguration(); configuration.activates=(p["activate"] as? Bool) ?? true
            do {
                let app: NSRunningApplication
                if method == "open_document" {
                    guard let path=p["path"] as? String, path.hasPrefix("/") else { throw DriverFailure("INVALID_PARAMS") }
                    try checkParent()
                    app = try await NSWorkspace.shared.open([URL(fileURLWithPath:path)],withApplicationAt:url,configuration:configuration)
                } else { try checkParent(); app = try await NSWorkspace.shared.openApplication(at:url,configuration:configuration) }
                return ["input_submitted":true,"app":appJSON(app)]
            } catch let failure as DriverFailure { throw failure } catch { throw DriverFailure("LAUNCH_FAILED") }
        case "get_state", "screenshot", "activate_app":
            let fullDisplay=method == "screenshot" && (p["full_display"] as? Bool) == true
            let app:NSRunningApplication
            if fullDisplay && p["app"] == nil {
                guard let frontmost=NSWorkspace.shared.frontmostApplication else { throw DriverFailure("APP_NOT_RUNNING") }; app=frontmost
            } else { app=try resolve(p["app"]) }
            retireTerminatedApps()
            let hasAX=AXIsProcessTrusted()
            if !fullDisplay { try requireAX() }
            let appElement=AXUIElementCreateApplication(app.processIdentifier)
            let windows=hasAX ? windowSnapshots(appElement,pid:app.processIdentifier) : []
            let selected: WindowSnapshot?
            if let requested=p["window_id"] as? String {
                guard let match=windows.first(where:{$0.id == requested}) else { throw DriverFailure("WINDOW_NOT_FOUND") }; selected=match
            } else {
                let focused=elements(appElement,kAXFocusedWindowAttribute).first
                selected=windows.first(where:{ focused != nil && CFEqual($0.element,focused!) }) ?? windows.first
            }
            var nodes:[String:NodeSnapshot]=[:]; var output:[[String:Any]]=[]
            // CFEqual guards cycles and shared AX descendants without an arbitrary traversal cap.
            var seen:[CFHashCode:[AXUIElement]]=[:]
            var stack:[(AXUIElement,String?,Bool)]=hasAX ? [(selected?.element ?? appElement,nil,false)] : []
            if hasAX { for menu in elements(appElement,kAXMenuBarAttribute) { stack.append((menu,nil,true)) } }
            while let (element,parent,isMenu)=stack.popLast() {
                let hash=CFHash(element)
                if seen[hash]?.contains(where:{CFEqual($0,element)}) == true { continue }
                seen[hash,default:[]].append(element)
                let id="e\(nodes.count+1)"; let ident=identity(element)
                nodes[id]=NodeSnapshot(element:element,identity:ident,menu:isMenu)
                var row:[String:Any]=["element_id":id,"role":ident.role,"label":ident.label,"enabled":(attribute(element,kAXEnabledAttribute) as? NSNumber)?.boolValue ?? true,"settable":settable(element,kAXValueAttribute),"actions":actions(element)]
                if let parent { row["parent_id"]=parent }; if let value=ident.value { row["value"]=value }; if let b=ident.bounds { row["bounds"]=rectJSON(b) }
                output.append(row)
                for child in elements(element,kAXChildrenAttribute).reversed() { stack.append((child,id,isMenu)) }
            }
            let id=UUID().uuidString
            let focused = (hasAX ? elements(appElement,kAXFocusedUIElementAttribute) : []).first.map { NodeSnapshot(element:$0,identity:identity($0)) }
            var observation=Observation(pid:app.processIdentifier,launched:app.launchDate,appElement:appElement,window:selected,nodes:nodes,focused:focused)
            var result:[String:Any]=["observation_id":id,"app":appJSON(app),"window":selected.map(windowJSON) ?? NSNull(),"windows":windows.map(windowJSON),"elements":output]
            if method == "screenshot" || (p["include_screenshot"] as? Bool) == true { result["image"]=try await capture(&observation,fullDisplay:fullDisplay) }
            if method == "activate_app" { try await activate(app,observation); result["input_submitted"]=true }
            observations.record(id:id,owner:app.processIdentifier,value:observation)
            return result
        case "click", "type_text", "press_key", "set_value", "scroll", "drag", "perform_action":
            let (_, observation, app)=try checkedObservation(p)
            try checkParent()
            let node=try checkedNode(p,observation,required:method == "set_value" || method == "perform_action")
            if method == "set_value" {
                guard let node, let value=p["value"], value is String || value is NSNumber else { throw DriverFailure("INVALID_PARAMS") }
                guard settable(node.element,kAXValueAttribute) else { throw DriverFailure("ATTRIBUTE_NOT_SETTABLE") }
                try checkParent()
                guard AXUIElementSetAttributeValue(node.element,kAXValueAttribute as CFString,value as CFTypeRef) == .success else { throw DriverFailure("INPUT_FAILED") }
            } else if method == "perform_action" {
                guard let node, let action=p["action"] as? String else { throw DriverFailure("INVALID_PARAMS") }
                guard actions(node.element).contains(action) else { throw DriverFailure("ACTION_NOT_SUPPORTED") }
                try checkParent()
                guard AXUIElementPerformAction(node.element,action as CFString) == .success else { throw DriverFailure("INPUT_FAILED") }
            } else if method == "click" {
                let button=p["button"] as? String ?? "left"
                let count=(p["click_count"] as? NSNumber)?.intValue ?? 1
                guard ["left","right","middle"].contains(button), count>0 else { throw DriverFailure("INVALID_PARAMS") }
                if let node, button == "left", count == 1, actions(node.element).contains(kAXPressAction) {
                    try checkParent()
                    guard AXUIElementPerformAction(node.element,kAXPressAction as CFString) == .success else { throw DriverFailure("INPUT_FAILED") }
                } else {
                    let target:CGPoint
                    if let node { target=try visibleCenter(node,observation); guard onScreen(target) else { throw DriverFailure("INVALID_COORDINATES") } }
                    else { target=try point(p["x"],p["y"],space:p["coordinate_space"] as? String ?? "screen",observation:observation) }
                    try await activate(app,observation); try ensureFrontmost(observation)
                    let mouseButton:CGMouseButton=button == "right" ? .right : button == "middle" ? .center : .left
                    let down:CGEventType=button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
                    let up:CGEventType=button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
                    try mouse(.mouseMoved,target,mouseButton)
                    for i in 1...count {
                        try ensureFrontmost(observation); try mouse(down,target,mouseButton,count:i)
                        do { try mouse(up,target,mouseButton,count:i) }
                        catch { releaseMouse(up,target,mouseButton); throw error }
                    }
                }
            } else if method == "type_text" {
                guard let text=p["text"] as? String else { throw DriverFailure("INVALID_PARAMS") }
                try await activate(app,observation)
                if let node {
                    try checkParent()
                    guard settable(node.element,kAXFocusedAttribute), AXUIElementSetAttributeValue(node.element,kAXFocusedAttribute as CFString,kCFBooleanTrue) == .success else { throw DriverFailure("FOCUS_FAILED") }
                    if settable(node.element,kAXSelectedTextAttribute) {
                        try checkParent()
                        guard AXUIElementSetAttributeValue(node.element,kAXSelectedTextAttribute as CFString,text as CFString) == .success else { throw DriverFailure("INPUT_FAILED") }
                        return ["input_submitted":true]
                    }
                }
                let expectedFocus = node ?? observation.focused
                try checkFocus(observation,expected:expectedFocus,strict:node == nil)
                for scalar in text.unicodeScalars { try ensureFrontmost(observation); try checkFocus(observation,expected:expectedFocus); try keyEvent(0,[],unicode:Array(String(scalar).utf16)) }
            } else if method == "press_key" {
                guard let key=p["key"] as? String else { throw DriverFailure("INVALID_PARAMS") }
                let (code,flags)=try keySpec(key); try await activate(app,observation); try ensureFrontmost(observation)
                try checkFocus(observation,expected:observation.focused,strict:true,allowBothAbsent:true)
                try keyEvent(code,flags)
            } else if method == "scroll" {
                let dx=(p["dx"] as? NSNumber)?.doubleValue ?? 0; let dy=(p["dy"] as? NSNumber)?.doubleValue ?? 0
                guard dx.isFinite, dy.isFinite, abs(dx)<=Double(Int32.max),abs(dy)<=Double(Int32.max) else { throw DriverFailure("INVALID_PARAMS") }
                try await activate(app,observation); try ensureFrontmost(observation)
                let target=try visibleCenter(node,observation)
                guard onScreen(target) else { throw DriverFailure("INVALID_COORDINATES") }
                try mouse(.mouseMoved,target,.left)
                guard let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(-dy),wheel2:Int32(-dx),wheel3:0) else { throw DriverFailure("INPUT_FAILED") }
                try checkParent(); event.post(tap:.cghidEventTap)
            } else if method == "drag" {
                let space=p["coordinate_space"] as? String ?? "screen"
                let from=try point(p["from_x"],p["from_y"],space:space,observation:observation)
                let to=try point(p["to_x"],p["to_y"],space:space,observation:observation,inside:space == "screenshot")
                try await activate(app,observation); try ensureFrontmost(observation)
                try mouse(.mouseMoved,from,.left); try mouse(.leftMouseDown,from,.left)
                // A posted down is always paired with an up, including loss of foreground.
                do {
                    for step in 1...20 {
                        try ensureFrontmost(observation)
                        let t=Double(step)/20
                        try mouse(.leftMouseDragged,CGPoint(x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t),.left)
                        try await Task.sleep(nanoseconds:10_000_000)
                    }
                    try mouse(.leftMouseUp,to,.left)
                } catch { releaseMouse(.leftMouseUp,from,.left); throw error }
            }
            return ["input_submitted":true]
        default:throw DriverFailure("METHOD_NOT_FOUND")
        }
    }
}

#if !NATIVE_DESKTOP_TESTING
@main struct NativeDesktopMain {
    @MainActor static func main() async {
        installNativeTerminationHandlers()
        let driver=DesktopDriver()
        if CommandLine.arguments.contains("--status") {
            let result=(try? await driver.handle("status",[:])) ?? [:]
            write(["id":"status","ok":true,"result":result]); return
        }
        var reader=NativeProtocolLineReader()
        while let line=reader.nextLine() {
            var id=""
            do {
                guard let data=line.data(using:.utf8), let request=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
                      let requestID=request["id"] as? String, let method=request["method"] as? String,
                      let params=request["params"] as? [String:Any] else { throw DriverFailure("INVALID_REQUEST") }
                id=requestID
                try checkNativeTermination()
                let result=try await driver.handle(method,params)
                write(["id":id,"ok":true,"result":result])
            } catch let failure as DriverFailure { write(["id":id,"ok":false,"error":["code":failure.code]]) }
              catch { write(["id":id,"ok":false,"error":["code":"NATIVE_DRIVER_ERROR"]]) }
        }
    }
    static func write(_ value:[String:Any]) {
        guard let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]), let line=String(data:data,encoding:.utf8) else { return }
        print(line); fflush(stdout)
    }
}

#endif
