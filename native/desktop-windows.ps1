# Optional Windows-only native executor. JSON-lines on stdin/stdout; no model calls.
# Requires Windows PowerShell 5.1, an interactive user session, and public .NET/Win32 APIs.
# UIA cannot bypass UIPI, the secure desktop, unavailable providers, or screen-capture restrictions.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$references = @('System.dll', 'System.Core.dll')
foreach ($assembly in @('UIAutomationClient','UIAutomationTypes','WindowsBase','System.Drawing','System.Windows.Forms')) {
    $references += [Reflection.Assembly]::LoadWithPartialName($assembly).Location
}
Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace JevNativeDesktop {
public sealed class Failure : Exception { public readonly string Code; public Failure(string code) : base(code) { Code=code; } }
public static class Driver {
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct PROCESSENTRY32 {
        public uint dwSize,cntUsage,th32ProcessID; public UIntPtr th32DefaultHeapID; public uint th32ModuleID,cntThreads,th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string szExeFile;
    }
    delegate bool EnumWindowsProc(IntPtr hwnd,IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback,IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] inputs,int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot,ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot,ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    sealed class Node { public AutomationElement Element; public string Identity; public string Runtime; public System.Windows.Rect Bounds; }
    sealed class Window { public IntPtr Handle; public AutomationElement Element; public string Identity; public System.Windows.Rect Bounds; public string Id; }
    sealed class Observation {
        public string Id; public int Pid; public long Started; public Window Window; public Dictionary<string,Node> Nodes=new Dictionary<string,Node>();
        public AutomationElement Focus; public string FocusIdentity; public System.Windows.Rect? ImageBounds; public int ImageWidth,ImageHeight;
    }
    static readonly Dictionary<string,Observation> observations=new Dictionary<string,Observation>();
    static readonly Dictionary<int,string> latest=new Dictionary<int,string>();
    static readonly string parentText=Environment.GetEnvironmentVariable("JEV_DESKTOP_PARENT_PID");
    static readonly long parentStarted=ParentStart();
    static bool dpiPhysical;
    static volatile bool stopRequested;
    static readonly BlockingCollection<string> inputLines=new BlockingCollection<string>();
    public static void StartInput() {
        var reader=new Thread(delegate() {
            try { string line;while((line=Console.ReadLine())!=null)inputLines.Add(line); }
            catch(IOException){} catch(ObjectDisposedException){}
            finally { RequestStop();inputLines.CompleteAdding(); }
        });reader.IsBackground=true;reader.Start();
    }
    public static string NextLine() { try{return inputLines.Take();}catch(InvalidOperationException){return null;} }
    static void RequestStop() { stopRequested=true; }
    static void CheckStop() { if(stopRequested)throw Fail("CANCELLED"); }

    static Driver() {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); dpiPhysical=GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())==2; } catch (EntryPointNotFoundException) { dpiPhysical=false; }
    }
    static Dictionary<string,object> Obj(params object[] pairs) { var r=new Dictionary<string,object>(); for(int i=0;i<pairs.Length;i+=2) r[(string)pairs[i]]=pairs[i+1]; return r; }
    static Failure Fail(string code) { return new Failure(code); }
    static object Get(IDictionary p,string key) { return p.Contains(key)?p[key]:null; }
    static string Text(IDictionary p,string key) { return Get(p,key) as string; }
    static string Required(IDictionary p,string key) { string s=Text(p,key); if(String.IsNullOrEmpty(s))throw Fail("INVALID_PARAMS"); return s; }
    static bool Flag(IDictionary p,string key) { return Get(p,key) is bool && (bool)Get(p,key); }
    static uint ActualParent() {
        IntPtr snapshot=CreateToolhelp32Snapshot(2,0); if(snapshot==new IntPtr(-1))return 0;
        try { var entry=new PROCESSENTRY32(); entry.dwSize=(uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if(Process32FirstW(snapshot,ref entry)) do { if(entry.th32ProcessID==(uint)Process.GetCurrentProcess().Id)return entry.th32ParentProcessID; } while(Process32NextW(snapshot,ref entry));
            return 0;
        } finally { CloseHandle(snapshot); }
    }
    static long ParentStart() { int expected; if(String.IsNullOrEmpty(parentText))return 0; if(!Int32.TryParse(parentText,out expected)||expected<=0)return -1;
        try { if(ActualParent()!=(uint)expected)return -1; using(var p=Process.GetProcessById(expected))return p.StartTime.ToUniversalTime().Ticks; } catch { return -1; }
    }
    static void CheckParent() {
        if(String.IsNullOrEmpty(parentText)){CheckStop();return;} int expected;
        if(parentStarted<0||!Int32.TryParse(parentText,out expected)||expected<=0||ActualParent()!=(uint)expected)throw Fail("PARENT_GONE");
        try { using(var process=Process.GetProcessById(expected))if(process.HasExited||process.StartTime.ToUniversalTime().Ticks!=parentStarted)throw Fail("PARENT_GONE"); }
        catch { throw Fail("PARENT_GONE"); }
        CheckStop();
    }
    static long Started(Process p) { try{return p.StartTime.ToUniversalTime().Ticks;}catch{throw Fail("APP_ACCESS_DENIED");} }
    static Dictionary<string,object> App(Process p) { return Obj("pid",p.Id,"name",p.ProcessName); }
    static Process Resolve(object app) {
        if(app==null)throw Fail("INVALID_PARAMS");
        long pid=0; bool numeric=!(app is string) && Int64.TryParse(Convert.ToString(app,CultureInfo.InvariantCulture),out pid);
        if(numeric) { if(pid<1||pid>Int32.MaxValue)throw Fail("INVALID_PARAMS"); try{return Process.GetProcessById((int)pid);}catch{throw Fail("APP_NOT_RUNNING");} }
        string name=app as string; if(String.IsNullOrEmpty(name))throw Fail("INVALID_PARAMS");
        var matches=new List<Process>();
        foreach(var p in Process.GetProcesses()) {
            bool match=false;
            try { string executable=null;if(Path.IsPathRooted(name))try{executable=p.MainModule.FileName;}catch(System.ComponentModel.Win32Exception){}
                match=AppMatches(name,p.ProcessName,executable);
            } catch(InvalidOperationException){} catch(System.ComponentModel.Win32Exception){}
            if(match)matches.Add(p);else p.Dispose();
        }
        if(matches.Count==0)throw Fail("APP_NOT_RUNNING");
        uint foreground; GetWindowThreadProcessId(GetForegroundWindow(),out foreground);
        Process chosen=matches.Find(delegate(Process p){return p.Id==(int)foreground;});
        if(chosen==null&&matches.Count>1) { foreach(var p in matches)p.Dispose();throw Fail("APP_AMBIGUOUS"); }
        if(chosen==null)chosen=matches[0]; foreach(var p in matches)if(p!=chosen)p.Dispose(); return chosen;
    }
    static bool AppMatches(string requested,string processName,string executable) {
        if(Path.IsPathRooted(requested))return executable!=null&&String.Equals(Path.GetFullPath(requested),Path.GetFullPath(executable),StringComparison.OrdinalIgnoreCase);
        return String.Equals(processName,Path.GetFileNameWithoutExtension(requested),StringComparison.OrdinalIgnoreCase);
    }
    static string Runtime(AutomationElement e) { return String.Join(".",Array.ConvertAll(e.GetRuntimeId(),delegate(int n){return n.ToString(CultureInfo.InvariantCulture);})); }
    static string Identity(AutomationElement e) { var c=e.Current; var b=c.BoundingRectangle; object value; string v=null;
        if(!c.IsPassword&&e.TryGetCurrentPattern(ValuePattern.Pattern,out value))v=((ValuePattern)value).Current.Value;
        return Runtime(e)+"\n"+c.ProcessId+"\n"+c.ControlType.ProgrammaticName+"\n"+c.Name+"\n"+b.ToString(CultureInfo.InvariantCulture)+"\n"+v;
    }
    static Dictionary<string,object> Rect(System.Windows.Rect b) { return Obj("x",b.X,"y",b.Y,"width",b.Width,"height",b.Height); }
    static List<Window> Windows(int pid) {
        var windows=new List<Window>();bool denied=false;
        EnumWindows(delegate(IntPtr hwnd,IntPtr state) { uint owner; GetWindowThreadProcessId(hwnd,out owner); if(owner!=(uint)pid||!IsWindowVisible(hwnd))return true;
            try { var e=AutomationElement.FromHandle(hwnd); var b=e.Current.BoundingRectangle;
                windows.Add(new Window{Handle=hwnd,Element=e,Identity=Identity(e),Bounds=b,Id="w"+hwnd.ToInt64().ToString("x",CultureInfo.InvariantCulture)});
            } catch(ElementNotAvailableException){} catch(UnauthorizedAccessException){denied=true;return false;} return true;
        },IntPtr.Zero);if(denied)throw Fail("PERMISSION_REQUIRED"); return windows;
    }
    static Dictionary<string,object> WindowJSON(Window w) { return Obj("window_id",w.Id,"title",w.Element.Current.Name,"bounds",w.Bounds.IsEmpty?null:Rect(w.Bounds)); }
    static List<string> Actions(AutomationElement e) {
        var actions=new List<string>(); object pattern;
        if(e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))actions.Add("invoke");
        if(e.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))actions.Add("toggle");
        if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))actions.Add("select");
        if(e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)&&((ExpandCollapsePattern)pattern).Current.ExpandCollapseState!=ExpandCollapseState.LeafNode){actions.Add("expand");actions.Add("collapse");}
        if(e.TryGetCurrentPattern(ScrollItemPattern.Pattern,out pattern))actions.Add("scroll_into_view");
        return actions;
    }
    static void Visit(Observation o,AutomationElement root,List<object> output,HashSet<string> seen) {
        var stack=new Stack<KeyValuePair<AutomationElement,string>>(); stack.Push(new KeyValuePair<AutomationElement,string>(root,null));
        while(stack.Count>0) {
            var item=stack.Pop(); var e=item.Key; var current=e.Current;
            if(current.ProcessId!=o.Pid)continue;
            string runtime=Runtime(e); if(!seen.Add(runtime))continue;
            string id="e"+(o.Nodes.Count+1); var bounds=current.BoundingRectangle;
            o.Nodes.Add(id,new Node{Element=e,Identity=Identity(e),Runtime=runtime,Bounds=bounds});
            object value; bool settable=e.TryGetCurrentPattern(ValuePattern.Pattern,out value)&&!((ValuePattern)value).Current.IsReadOnly;
            var row=Obj("element_id",id,"role",current.ControlType.ProgrammaticName,"label",current.Name,"enabled",current.IsEnabled,"settable",settable,"actions",Actions(e));
            if(item.Value!=null)row["parent_id"]=item.Value;
            if(!bounds.IsEmpty)row["bounds"]=Rect(bounds);
            if(current.IsPassword)row["protected_value"]=true;
            else if(value!=null)row["value"]=((ValuePattern)value).Current.Value;
            output.Add(row);
            // RawView exposes the actual provider tree, including menu controls. No node/depth quota.
            var children=new List<AutomationElement>(); var child=TreeWalker.RawViewWalker.GetFirstChild(e);
            while(child!=null){children.Add(child);child=TreeWalker.RawViewWalker.GetNextSibling(child);}
            for(int i=children.Count-1;i>=0;i--)stack.Push(new KeyValuePair<AutomationElement,string>(children[i],id));
        }
    }
    static void Remember(Observation o) {
        string old; if(latest.TryGetValue(o.Pid,out old))observations.Remove(old);
        latest[o.Pid]=o.Id;observations[o.Id]=o;
        var dead=new List<int>();foreach(var pair in latest)try{using(var p=Process.GetProcessById(pair.Key)){if(p.HasExited)dead.Add(pair.Key);}}catch{dead.Add(pair.Key);}
        foreach(int pid in dead){observations.Remove(latest[pid]);latest.Remove(pid);}
    }
    static Observation Checked(IDictionary p) {
        Observation o; string id=Text(p,"observation_id"); if(id==null||!observations.TryGetValue(id,out o))throw Fail("STALE_OBSERVATION");
        using(var app=Resolve(Get(p,"app"))) { if(app.Id!=o.Pid||Started(app)!=o.Started)throw Fail("STALE_OBSERVATION"); }
        if(o.Window!=null) {
            uint owner;GetWindowThreadProcessId(o.Window.Handle,out owner);
            if(!IsWindow(o.Window.Handle)||owner!=(uint)o.Pid||Identity(o.Window.Element)!=o.Window.Identity)throw Fail("STALE_OBSERVATION");
        }
        return o;
    }
    static Node CheckedNode(IDictionary p,Observation o,bool required) {
        string id=Text(p,"element_id"); if(id==null){if(required)throw Fail("INVALID_PARAMS");return null;}
        Node n;if(!o.Nodes.TryGetValue(id,out n)||n.Element.Current.ProcessId!=o.Pid||Identity(n.Element)!=n.Identity)throw Fail("STALE_OBSERVATION");
        if(!n.Element.Current.IsEnabled)throw Fail("ELEMENT_DISABLED");return n;
    }
    static bool Same(AutomationElement a,AutomationElement b) { return a==null?b==null:b!=null&&Automation.Compare(a,b); }
    static bool ForegroundHandleMatches(IntPtr observed,IntPtr current) { return observed!=IntPtr.Zero&&observed==current; }
    static bool ForegroundMatches(Window w) { return w!=null&&ForegroundHandleMatches(w.Handle,GetForegroundWindow()); }
    static void EnsureFront(Observation o) {
        CheckParent();if(o.Window==null||!IsWindow(o.Window.Handle)||!ForegroundMatches(o.Window))throw Fail("FOCUS_CHANGED");
        uint owner;GetWindowThreadProcessId(o.Window.Handle,out owner);if(owner!=(uint)o.Pid)throw Fail("STALE_OBSERVATION");
        var bounds=o.Window.Element.Current.BoundingRectangle;
        if(bounds!=o.Window.Bounds)throw Fail("STALE_OBSERVATION");
    }
    static void CheckFocus(AutomationElement expected) { if(!Same(expected,AutomationElement.FocusedElement))throw Fail("FOCUS_CHANGED"); }
    static void RequireInitialFocusIdentity(string observed,string current) { if(observed!=current)throw Fail("STALE_OBSERVATION"); }
    static void CheckObservedFocus(Observation o) { var current=AutomationElement.FocusedElement;if(!Same(o.Focus,current))throw Fail("FOCUS_CHANGED");RequireInitialFocusIdentity(o.FocusIdentity,current==null?null:Identity(current)); }
    static void Activate(Observation o,bool intentionalWindowSwitch=false) {
        CheckParent();if(o.Window==null)throw Fail("WINDOW_NOT_FOUND");
        IntPtr foreground=GetForegroundWindow();uint owner;GetWindowThreadProcessId(foreground,out owner);
        // A newly focused same-app popup has not inherited the observed window's grounding.
        if(!intentionalWindowSwitch&&owner==(uint)o.Pid&&!ForegroundHandleMatches(o.Window.Handle,foreground))throw Fail("FOCUS_CHANGED");
        if(IsIconic(o.Window.Handle)){CheckParent();ShowWindow(o.Window.Handle,9);}
        CheckParent();SetForegroundWindow(o.Window.Handle);
        for(int i=0;i<100;i++){CheckParent();if(ForegroundMatches(o.Window))return;Thread.Sleep(20);}throw Fail("ACTIVATION_FAILED");
    }
    static double Number(IDictionary p,string name) { object v=Get(p,name);if(v==null||v is string||v is bool)throw Fail("INVALID_PARAMS");double n;
        try{n=Convert.ToDouble(v,CultureInfo.InvariantCulture);}catch{throw Fail("INVALID_PARAMS");}if(Double.IsNaN(n)||Double.IsInfinity(n))throw Fail("INVALID_PARAMS");return n;
    }
    static POINT Point(Observation o,double x,double y,string space,bool inside) {
        if(!dpiPhysical)throw Fail("DPI_MAPPING_UNAVAILABLE");
        if(space=="screenshot") {
            if(!o.ImageBounds.HasValue||x<0||y<0||x>=o.ImageWidth||y>=o.ImageHeight)throw Fail("INVALID_COORDINATES");
            var b=o.ImageBounds.Value;x=b.X+x*b.Width/o.ImageWidth;y=b.Y+y*b.Height/o.ImageHeight;
        } else if(space!="screen")throw Fail("INVALID_PARAMS");
        if(x<Int32.MinValue||x>Int32.MaxValue||y<Int32.MinValue||y>Int32.MaxValue)throw Fail("INVALID_COORDINATES");
        var point=new System.Windows.Point(x,y);bool onScreen=false;foreach(var screen in Screen.AllScreens)if(screen.Bounds.Contains((int)x,(int)y)){onScreen=true;break;}
        if(!onScreen)throw Fail("INVALID_COORDINATES");
        if(inside && (o.Window==null||!o.Window.Bounds.Contains(point))) {
            bool inMenu=false;foreach(var n in o.Nodes.Values)if(n.Element.Current.ControlType==ControlType.MenuItem&&n.Bounds.Contains(point)){inMenu=true;break;}
            if(!inMenu)throw Fail("INVALID_COORDINATES");
        }
        return new POINT{X=(int)Math.Floor(x),Y=(int)Math.Floor(y)};
    }
    static POINT Center(Observation o,Node n) { var b=n==null?(o.Window==null?System.Windows.Rect.Empty:o.Window.Bounds):n.Bounds;
        if(b.IsEmpty||b.Width<=0||b.Height<=0||(n!=null&&n.Element.Current.IsOffscreen))throw Fail("INVALID_COORDINATES");
        return Point(o,b.X+b.Width/2,b.Y+b.Height/2,"screen",true);
    }
    static INPUT Mouse(uint flags,uint data,POINT? point) {
        var input=new INPUT{type=0}; input.data.mi.dwFlags=flags;input.data.mi.mouseData=data;
        if(point.HasValue){int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
            if(width<=1||height<=1)throw Fail("INVALID_COORDINATES");
            input.data.mi.dx=(int)Math.Round((point.Value.X-left)*65535.0/(width-1));input.data.mi.dy=(int)Math.Round((point.Value.Y-top)*65535.0/(height-1));input.data.mi.dwFlags|=0xC001;
        }return input;
    }
    static INPUT Key(ushort vk,ushort scan,uint flags) { var i=new INPUT{type=1};i.data.ki.wVk=vk;i.data.ki.wScan=scan;i.data.ki.dwFlags=flags;return i; }
    static void Submit(Observation o,INPUT input,AutomationElement focus,bool checkFocus) {
        EnsureFront(o);if(checkFocus)CheckFocus(focus);CheckParent();
        RawSubmit(input);
    }
    static void RawSubmit(INPUT input) { if(SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT)))!=1)throw Fail("INPUT_REJECTED"); }
    static void SubmitRelease(INPUT input) { CheckParent();RawSubmit(input); }
    // Release cleanup never sends a fresh press, click, focus, move, or application action.
    static void Release(INPUT input) { SendInput(1,new INPUT[]{input},Marshal.SizeOf(typeof(INPUT))); }
    static void Paired(Observation o,INPUT down,INPUT up,AutomationElement focus,bool checkFocus) {
        PostPair(CheckParent,delegate{Submit(o,down,focus,checkFocus);},delegate{RawSubmit(up);},delegate{Release(up);});
    }
    static void PostPair(Action parentCheck,Action down,Action up,Action cleanup) {
        bool pressed=false;try{parentCheck();down();pressed=true;parentCheck();up();pressed=false;}finally{if(pressed)cleanup();}
    }
    static ushort VirtualKey(string key) {
        if(key.Length==1){char c=Char.ToUpperInvariant(key[0]);if((c>='A'&&c<='Z')||(c>='0'&&c<='9'))return (ushort)c;}
        switch(key){case "return":case "enter":return 13;case "tab":return 9;case "escape":case "esc":return 27;case "space":return 32;
            case "backspace":return 8;case "delete":return 46;case "insert":return 45;case "left":return 37;case "up":return 38;case "right":return 39;case "down":return 40;
            case "home":return 36;case "end":return 35;case "pageup":return 33;case "pagedown":return 34;case "printscreen":return 44;}
        int number;if(key.StartsWith("f")&&Int32.TryParse(key.Substring(1),out number)&&number>=1&&number<=24)return (ushort)(111+number);
        throw Fail("KEY_NOT_SUPPORTED");
    }
    static uint KeyFlags(ushort key) { return key==33||key==34||key==35||key==36||key==37||key==38||key==39||key==40||key==45||key==46||key==91?1u:0u; }
    static void Press(Observation o,string chord) {
        string[] parts=chord.ToLowerInvariant().Split('+');if(parts.Length==0)throw Fail("INVALID_PARAMS");
        var modifiers=new List<ushort>();for(int i=0;i<parts.Length-1;i++)switch(parts[i]){
            case "ctrl":case "control":modifiers.Add(17);break;case "alt":case "option":modifiers.Add(18);break;case "shift":modifiers.Add(16);break;
            case "win":case "windows":case "super":case "meta":case "cmd":case "command":modifiers.Add(91);break;default:throw Fail("KEY_NOT_SUPPORTED");}
        ushort key=VirtualKey(parts[parts.Length-1]);var held=new List<INPUT>();
        try {
            EnsureFront(o);CheckObservedFocus(o);
            foreach(ushort modifier in modifiers){uint flags=KeyFlags(modifier);Submit(o,Key(modifier,0,flags),o.Focus,true);held.Add(Key(modifier,0,flags|2));}
            uint keyFlags=KeyFlags(key);Paired(o,Key(key,0,keyFlags),Key(key,0,keyFlags|2),o.Focus,true);
            for(int i=held.Count-1;i>=0;i--){SubmitRelease(held[i]);held.RemoveAt(i);}
        }finally{for(int i=held.Count-1;i>=0;i--)Release(held[i]);}
    }
    static Dictionary<string,object> Capture(Observation o,bool fullDisplay) {
        if(!dpiPhysical)throw Fail("DPI_MAPPING_UNAVAILABLE");
        if(!Interactive())throw Fail("INTERACTIVE_DESKTOP_REQUIRED");
        System.Drawing.Rectangle area;
        if(fullDisplay){var screen=o.Window==null?Screen.FromHandle(GetForegroundWindow()):Screen.FromHandle(o.Window.Handle);area=screen.Bounds;}
        else {
            if(o.Window==null)throw Fail("WINDOW_NOT_FOUND");if(IsIconic(o.Window.Handle))throw Fail("WINDOW_NOT_VISIBLE");
            RECT r;if(!GetWindowRect(o.Window.Handle,out r))throw Fail("CAPTURE_FAILED");area=System.Drawing.Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);
            // CopyFromScreen faithfully captures visible pixels, including occlusion; report that scope explicitly.
            if(area.Width<=0||area.Height<=0||!SystemInformation.VirtualScreen.Contains(area))throw Fail("WINDOW_NOT_VISIBLE");
        }
        using(var bitmap=new Bitmap(area.Width,area.Height,PixelFormat.Format32bppArgb)) {
            using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(area.Location,System.Drawing.Point.Empty,area.Size,CopyPixelOperation.SourceCopy);
            if(o.Window!=null&&Identity(o.Window.Element)!=o.Window.Identity)throw Fail("STALE_OBSERVATION");
            using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);var bounds=new System.Windows.Rect(area.X,area.Y,area.Width,area.Height);
                o.ImageBounds=bounds;o.ImageWidth=bitmap.Width;o.ImageHeight=bitmap.Height;
                return Obj("mimeType","image/png","data",Convert.ToBase64String(stream.ToArray()),"width",bitmap.Width,"height",bitmap.Height,
                    "coordinate_space","screenshot","screen_bounds",Rect(bounds),"scale_x",1.0,"scale_y",1.0,"screen_coordinate_system","windows_physical_pixels_top_left",
                    "capture_source","visible_screen_pixels","occlusion_possible",!fullDisplay);
            }
        }
    }
    static bool Interactive() { IntPtr desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;CloseDesktop(desktop);return Environment.UserInteractive; }
    static object Observe(string method,IDictionary p) {
        bool full=method=="screenshot"&&Flag(p,"full_display");object app=Get(p,"app");
        if(full&&app==null){uint pid;GetWindowThreadProcessId(GetForegroundWindow(),out pid);app=(int)pid;}
        using(var process=Resolve(app)) {
            var windows=Windows(process.Id);Window selected=null;string requested=Text(p,"window_id");
            if(requested!=null){selected=windows.Find(delegate(Window w){return w.Id==requested;});if(selected==null)throw Fail("WINDOW_NOT_FOUND");}
            else {selected=windows.Find(delegate(Window w){return w.Handle==GetForegroundWindow();});if(selected==null&&windows.Count>0)selected=windows[0];}
            var o=new Observation{Id=Guid.NewGuid().ToString(),Pid=process.Id,Started=Started(process),Window=selected};
            if(method=="activate_app") {
                Activate(o,true);string selectedId=selected.Id;windows=Windows(process.Id);
                selected=windows.Find(delegate(Window w){return w.Id==selectedId;});if(selected==null)throw Fail("WINDOW_NOT_FOUND");o.Window=selected;
            }
            o.Focus=AutomationElement.FocusedElement;
            if(o.Focus!=null&&o.Focus.Current.ProcessId!=o.Pid)o.Focus=null;
            o.FocusIdentity=o.Focus==null?null:Identity(o.Focus);
            var elements=new List<object>();var seen=new HashSet<string>();if(selected!=null)Visit(o,selected.Element,elements,seen);
            // Top-level menu popups may be siblings rather than descendants in UIA.
            foreach(var w in windows)if(w!=selected&&(w.Element.Current.ControlType==ControlType.Menu||w.Element.Current.ClassName=="#32768"))Visit(o,w.Element,elements,seen);
            var jsonWindows=new List<object>();foreach(var w in windows)jsonWindows.Add(WindowJSON(w));
            var result=Obj("observation_id",o.Id,"app",App(process),"window",selected==null?null:WindowJSON(selected),"windows",jsonWindows,"elements",elements);
            if(method=="screenshot"||Flag(p,"include_screenshot"))result["image"]=Capture(o,full);
            if(method=="activate_app")result["input_submitted"]=true;
            Remember(o);return result;
        }
    }
    static object Launch(string method,IDictionary p) {
        CheckParent();object app=Get(p,"app");if(app==null)throw Fail("INVALID_PARAMS");
        string file=null;Process existing=null;
        try { existing=Resolve(app); } catch(Failure e) { if(e.Code!="APP_NOT_RUNNING")throw; }
        if(existing!=null) {
            using(existing) {
                if(method=="launch_app") {
                    if(!p.Contains("activate")||Flag(p,"activate")){CheckParent();Observe("activate_app",Obj("app",existing.Id));}
                    return Obj("input_submitted",true,"app",App(existing));
                }
                try { file=existing.MainModule.FileName; }catch { throw Fail("APP_ACCESS_DENIED"); }
            }
        } else {file=app as string;if(String.IsNullOrEmpty(file))throw Fail("APP_NOT_RUNNING");}
        string arguments=null;
        if(method=="open_document") {
            string path=Required(p,"path");if(!Path.IsPathRooted(path)||!File.Exists(path))throw Fail("DOCUMENT_NOT_FOUND");
            // CreateProcess argument quoting: double each backslash before a quote or final quote.
            arguments=QuoteArgument(Path.GetFullPath(path));
        }
        var start=new ProcessStartInfo(file);start.UseShellExecute=true;
        if(arguments!=null)start.Arguments=arguments;
        // Newly launched applications control their own initial activation. Existing apps honor activate=false above.
        CheckParent();Process launched;
        try { launched=Process.Start(start); }catch { throw Fail("LAUNCH_FAILED"); }
        if(launched==null)return Obj("input_submitted",true,"launch_identity_available",false);
        using(launched)return Obj("input_submitted",true,"app",App(launched));
    }
    static string QuoteArgument(string text) {
        var b=new StringBuilder("\"");int slashes=0;
        foreach(char c in text){if(c=='\\'){slashes++;continue;}if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else{b.Append('\\',slashes);b.Append(c);}slashes=0;}
        b.Append('\\',slashes*2);b.Append('\"');return b.ToString();
    }
    static object Input(string method,IDictionary p) {
        var o=Checked(p);CheckParent();var node=CheckedNode(p,o,method=="set_value"||method=="perform_action");
        if(method=="set_value") {
            object pattern;if(!node.Element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)||((ValuePattern)pattern).Current.IsReadOnly)throw Fail("VALUE_NOT_SETTABLE");
            string value=Text(p,"value");if(value==null)throw Fail("INVALID_PARAMS");Activate(o);EnsureFront(o);CheckParent();((ValuePattern)pattern).SetValue(value);
        } else if(method=="perform_action") {
            string action=Required(p,"action");if(!Actions(node.Element).Contains(action))throw Fail("ACTION_NOT_SUPPORTED");
            Activate(o);EnsureFront(o);CheckParent();
            switch(action){case "invoke":((InvokePattern)node.Element.GetCurrentPattern(InvokePattern.Pattern)).Invoke();break;
                case "toggle":((TogglePattern)node.Element.GetCurrentPattern(TogglePattern.Pattern)).Toggle();break;
                case "select":((SelectionItemPattern)node.Element.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();break;
                case "expand":((ExpandCollapsePattern)node.Element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Expand();break;
                case "collapse":((ExpandCollapsePattern)node.Element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse();break;
                case "scroll_into_view":((ScrollItemPattern)node.Element.GetCurrentPattern(ScrollItemPattern.Pattern)).ScrollIntoView();break;}
        } else if(method=="type_text") {
            string text=Text(p,"text");if(text==null)throw Fail("INVALID_PARAMS");Activate(o);EnsureFront(o);
            AutomationElement expected=o.Focus;
            if(node!=null){if(!node.Element.Current.IsKeyboardFocusable)throw Fail("ELEMENT_NOT_FOCUSABLE");CheckParent();node.Element.SetFocus();expected=node.Element;}
            CheckFocus(expected);if(node==null)CheckObservedFocus(o);
            // Send each UTF-16 code unit without touching the user's clipboard.
            foreach(char c in text)Paired(o,Key(0,c,4),Key(0,c,6),expected,true);
        } else if(method=="press_key") {string key=Required(p,"key");Activate(o);Press(o,key);
        } else if(method=="click") {
            if(node!=null&&(Get(p,"x")!=null||Get(p,"y")!=null))throw Fail("INVALID_PARAMS");
            string button=Text(p,"button")??"left";uint down,up;
            switch(button){case "left":down=2;up=4;break;case "right":down=8;up=16;break;case "middle":down=32;up=64;break;default:throw Fail("INVALID_PARAMS");}
            long count=1;if(Get(p,"click_count")!=null){double n=Number(p,"click_count");if(n<1||n>9007199254740991||n!=Math.Truncate(n))throw Fail("INVALID_PARAMS");count=(long)n;}
            POINT target=node==null?Point(o,Number(p,"x"),Number(p,"y"),Text(p,"coordinate_space")??"screen",true):Center(o,node);
            Activate(o);for(long i=0;i<count;i++){Submit(o,Mouse(0,0,target),null,false);Paired(o,Mouse(down,0,null),Mouse(up,0,null),null,false);}
        } else if(method=="scroll") {
            double dx=Get(p,"dx")==null?0:Number(p,"dx"),dy=Get(p,"dy")==null?0:Number(p,"dy");
            if(dx<Int32.MinValue||dx>Int32.MaxValue||dy<Int32.MinValue||dy>Int32.MaxValue)throw Fail("INVALID_PARAMS");
            POINT target=Center(o,node);Activate(o);Submit(o,Mouse(0,0,target),null,false);
            if(dy!=0)Submit(o,Mouse(0x800,unchecked((uint)(int)-dy),null),null,false);
            if(dx!=0)Submit(o,Mouse(0x1000,unchecked((uint)(int)dx),null),null,false);
        } else if(method=="drag") {
            string space=Text(p,"coordinate_space")??"screen";
            POINT from=Point(o,Number(p,"from_x"),Number(p,"from_y"),space,true),to=Point(o,Number(p,"to_x"),Number(p,"to_y"),space,space=="screenshot");
            Activate(o);Submit(o,Mouse(0,0,from),null,false);bool pressed=false;
            try {Submit(o,Mouse(2,0,null),null,false);pressed=true;Submit(o,Mouse(0,0,to),null,false);SubmitRelease(Mouse(4,0,null));pressed=false;}
            finally{if(pressed)Release(Mouse(4,0,null));}
        }
        observations.Remove(o.Id);latest.Remove(o.Pid);
        return Obj("input_submitted",true,"requires_fresh_observation",true);
    }
    public static object Handle(string method,IDictionary p) {
        try {
            switch(method) {
                case "status":bool accessible;try{accessible=AutomationElement.RootElement!=null;}catch{accessible=false;}
                    return Obj("platform","windows","accessibility",accessible,"screen_capture","not_probed","interactive_desktop",Interactive(),"physical_pixel_mapping",dpiPhysical,
                        "driver","native-public-api","input_requires_observation",true,"app_inventory_scope","running","screenshot_scopes",new string[]{"window","display"});
                case "list_apps":var apps=new List<object>();foreach(var process in Process.GetProcesses())using(process)try{apps.Add(App(process));}catch(InvalidOperationException){}return Obj("scope","running","apps",apps);
                case "launch_app":case "open_document":return Launch(method,p);
                case "get_state":case "screenshot":case "activate_app":return Observe(method,p);
                case "click":case "type_text":case "press_key":case "set_value":case "scroll":case "drag":case "perform_action":return Input(method,p);
                default:throw Fail("METHOD_NOT_FOUND");
            }
        } catch(Failure){throw;} catch(ElementNotAvailableException){throw Fail("STALE_OBSERVATION");}
        catch(ElementNotEnabledException){throw Fail("ELEMENT_DISABLED");}catch(UnauthorizedAccessException){throw Fail("PERMISSION_REQUIRED");}
        catch(System.Runtime.InteropServices.COMException){throw Fail("UI_AUTOMATION_ERROR");}
    }
}
}
'@
function ConvertTo-NativeMap($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [System.Management.Automation.PSCustomObject]) {
        $map = @{}
        foreach ($property in $value.PSObject.Properties) { $map[$property.Name] = ConvertTo-NativeMap $property.Value }
        return $map
    }
    if ($value -is [System.Array]) { return ,@($value | ForEach-Object { ConvertTo-NativeMap $_ }) }
    return $value
}
[JevNativeDesktop.Driver]::StartInput()
while ($null -ne ($line = [JevNativeDesktop.Driver]::NextLine())) {
    $requestId = $null
    try {
        try { $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop } catch { throw 'INVALID_REQUEST' }
        if ($null -eq $request -or $request -isnot [System.Management.Automation.PSCustomObject]) { throw 'INVALID_REQUEST' }
        $requestId = $request.id
        if ($request.method -isnot [string] -or $request.params -isnot [System.Management.Automation.PSCustomObject]) { throw 'INVALID_REQUEST' }
        $result = [JevNativeDesktop.Driver]::Handle($request.method, (ConvertTo-NativeMap $request.params))
        $reply = @{ id=$requestId; ok=$true; result=$result }
    } catch {
        $code = 'NATIVE_DRIVER_ERROR'
        $exception = $_.Exception
        while ($null -ne $exception) {
            if ($exception -is [JevNativeDesktop.Failure]) { $code=$exception.Code; break }
            if ($exception.Message -eq 'INVALID_REQUEST') { $code='INVALID_REQUEST'; break }
            $exception=$exception.InnerException
        }
        $reply = @{ id=$requestId; ok=$false; error=@{code=$code} }
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Depth 100 -Compress))
    [Console]::Out.Flush()
}
