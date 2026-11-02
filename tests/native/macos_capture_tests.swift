import Foundation

@main struct CaptureRegressionTests {
    static let bounds=CGRect(x:99,y:30,width:2046,height:1215)
    static func window(_ title:String, owner:pid_t? = 12145, bounds:CGRect = bounds) -> CaptureWindowIdentity {
        CaptureWindowIdentity(owner:owner,bounds:bounds,title:title)
    }
    static func match(_ candidates:[CaptureWindowIdentity], title:String = "Example Domain", applicationName:String? = "Google Chrome") throws -> Int {
        try requireUniqueCaptureWindow(candidates,owner:12145,bounds:bounds,title:title,applicationName:applicationName)
    }
    static func expectMissing(_ candidates:[CaptureWindowIdentity], title:String = "Example Domain", applicationName:String? = "Google Chrome") {
        do { _ = try match(candidates,title:title,applicationName:applicationName); fatalError("expected WINDOW_NOT_FOUND") }
        catch let failure as DriverFailure { precondition(failure.code == "WINDOW_NOT_FOUND") }
        catch { fatalError("unexpected error") }
    }
    static func main() throws {
        let exact=try match([window("Example Domain")])
        precondition(exact == 0)
        expectMissing([])
        expectMissing([window("Example Domain"),window("Example Domain")])
        expectMissing([window("Example Domain",owner:777)])
        expectMissing([window("Example Domain",owner:nil)])
        expectMissing([window("Example Domain",bounds:CGRect(x:99,y:30,width:66,height:20))])
        expectMissing([window("Unrelated")])
        // Real Chrome reports the app suffix through AX but omits it in ScreenCaptureKit.
        do {
            let chrome=try match([window("Example Domain")],title:"Example Domain - Google Chrome")
            precondition(chrome == 0)
        } catch {
            fputs("Chrome app-suffix title regression: expected the same observed window to match\n",stderr)
            exit(1)
        }
        let reversed=try match([window("Example Domain - Google Chrome")])
        precondition(reversed == 0)
        let localized=try match([window("示例页面")],title:"示例页面 - 浏览器",applicationName:"浏览器")
        precondition(localized == 0)
        let appTitle=try match([window("Google Chrome")],title:"Google Chrome")
        let noAppName=try match([window("Example Domain")],applicationName:nil)
        precondition(appTitle == 0 && noAppName == 0)
        // Owner and exact geometry still isolate the target from other apps and panels.
        let target=try match([window("Example Domain",owner:777),window("Example Domain",bounds:CGRect(x:99,y:30,width:66,height:20)),window("Example Domain")],title:"Example Domain - Google Chrome")
        precondition(target == 2)
        expectMissing([window("Example Domain"),window("Example Domain - Google Chrome")])
        expectMissing([window("Example Domain",owner:777)],title:"Example Domain - Google Chrome")
        expectMissing([window("Example Domain",bounds:bounds.offsetBy(dx:0,dy:1))],title:"Example Domain - Google Chrome")
        expectMissing([window("Unrelated")],title:"Example Domain - Google Chrome")
        expectMissing([window("Example Domain - Other App")])
        expectMissing([window("Example Domain")],title:"Example Domain - Google Chrome",applicationName:nil)
        expectMissing([window("Example Domain")],title:"Example Domain - Google Chrome",applicationName:"")
        expectMissing([window("Example Domain")],title:"Example Domain - Google Chrome",applicationName:"Other App")
        expectMissing([window("Example Domain")],title:"example domain - Google Chrome")
        expectMissing([window("Example Domain")],title:"Example Domain - Google Chrome extra")
        expectMissing([window("")],title:"Google Chrome")
        expectMissing([window("")],title:" - Google Chrome")
        expectMissing([window("   ")],title:"    - Google Chrome")
        print("window capture regression checks passed")
    }
}
