import Foundation
import ApplicationServices
import AppKit

@main struct FocusRegressionTests {
    static func expectFocusFailure(_ action: () throws -> Void) {
        do { try action(); fatalError("expected FOCUS_CHANGED") }
        catch let failure as DriverFailure { precondition(failure.code == "FOCUS_CHANGED") }
        catch { fatalError("unexpected error") }
    }
    @MainActor static func main() throws {
        _ = DesktopDriver()
        precondition(NSApp != nil, "native driver must initialize the AppKit/WindowServer connection")
        precondition(NSApp.windows.isEmpty, "driver initialization must not create windows")
        // These are opaque synthetic AX references; no attributes/UI are observed.
        let first = AXUIElementCreateApplication(1234567)
        let second = AXUIElementCreateApplication(1234568)
        try requireMatchingAXFocus(expected:nil,current:nil,allowBothAbsent:true)
        try requireMatchingAXFocus(expected:first,current:first,allowBothAbsent:false)
        expectFocusFailure { try requireMatchingAXFocus(expected:nil,current:first,allowBothAbsent:true) }
        expectFocusFailure { try requireMatchingAXFocus(expected:first,current:nil,allowBothAbsent:true) }
        expectFocusFailure { try requireMatchingAXFocus(expected:first,current:second,allowBothAbsent:true) }
        expectFocusFailure { try requireMatchingAXFocus(expected:nil,current:nil,allowBothAbsent:false) }
        var sequence:[String]=[]
        var checks=0
        do {
            try postPairedKeyInput(parentCheck:{
                checks += 1; sequence.append("check")
                if checks == 2 { throw DriverFailure("PARENT_GONE") }
            },down:{sequence.append("down")},up:{sequence.append("up")},cleanup:{sequence.append("release")})
            fatalError("expected parent fence")
        } catch let failure as DriverFailure { precondition(failure.code == "PARENT_GONE") }
        precondition(sequence == ["check","down","check","release"])
        var store=LatestObservationStore<String>()
        store.record(id:"app-one-old",owner:100,value:"old")
        store.record(id:"app-two",owner:200,value:"independent")
        store.record(id:"app-one-new",owner:100,value:"new")
        precondition(store["app-one-old"] == nil)
        precondition(store["app-one-new"] == "new" && store["app-two"] == "independent")
        store.prune(liveOwners:[100])
        precondition(store["app-two"] == nil && store["app-one-new"] == "new")
        installNativeTerminationHandlers()
        sequence=[]
        do {
            try postPairedKeyInput(parentCheck:checkNativeTermination,down:{sequence.append("down"); raise(SIGTERM)},up:{sequence.append("up")},cleanup:{sequence.append("release")})
            fatalError("expected cooperative stop")
        } catch let failure as DriverFailure { precondition(failure.code == "STOPPING") }
        precondition(sequence == ["down","release"])
        print("focus and per-post parent-fence regression checks passed")
    }
}
