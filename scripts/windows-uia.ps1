param([switch]$Server)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Fail([string]$code) { throw $code }
function FindWindow($spec) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$spec.process_id)
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
    foreach ($window in $windows) {
        if ($window.Current.NativeWindowHandle -eq [int]$spec.window_handle) { return $window }
    }
    Fail 'WINDOW_UNAVAILABLE'
}
function Describe($element) {
    $c = $element.Current
    $ops = [Collections.Generic.List[string]]::new()
    if ($element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)) { $ops.Add('invoke') }
    if ($element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty) -and -not $c.IsPassword) { $ops.Add('set_value') }
    if ($element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)) { $ops.Add('toggle') }
    if ($element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)) { $ops.Add('select') }
    $value = $null
    if ($ops.Contains('set_value')) { $value = $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value }
    $rect = $c.BoundingRectangle
    $bounds = if ($rect.IsEmpty -or [double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y)) { $null } else { @{x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height} }
    return [ordered]@{control_id=($element.GetRuntimeId() -join '.'); name=if ($c.IsPassword) {'<private>'} else {$c.Name}; automation_id=$c.AutomationId; type=$c.ControlType.ProgrammaticName; enabled=$c.IsEnabled; offscreen=$c.IsOffscreen; password=$c.IsPassword; value=$value; operations=@($ops.ToArray()); rect=$bounds}
}
function Invoke-JevRequest($request) {
$script:jevInputStarted=$false
try {
    if ($request.operation -eq 'list') {
        $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
        $items = @()
        foreach ($window in $windows) { try { $c=$window.Current; if ($c.NativeWindowHandle -and -not $c.IsOffscreen) { $items += @{process_id=$c.ProcessId;window_handle=$c.NativeWindowHandle;name=$c.Name} } } catch {} }
        @{windows=$items} | ConvertTo-Json -Depth 10 -Compress
        return
    }
    $window = FindWindow $request.target
    $proc = Get-Process -Id $request.target.process_id
    $started = $proc.StartTime.ToUniversalTime().ToString('o')
    if ($request.target.process_started -and $request.target.process_started -ne $started) { Fail 'PROCESS_IDENTITY_CHANGED' }
    if ($request.operation -eq 'screenshot') {
        Add-Type -AssemblyName System.Drawing
        if (-not ('JevWindowImage' -as [type])) { Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class JevWindowImage {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
}
'@
        }
        $bounds=[JevWindowImage+Rect]::new();$handle=[IntPtr]::new($request.target.window_handle)
        if (-not [JevWindowImage]::GetWindowRect($handle,[ref]$bounds)) { Fail 'WINDOW_UNAVAILABLE' }
        $bitmap=[Drawing.Bitmap]::new($bounds.Right-$bounds.Left,$bounds.Bottom-$bounds.Top)
        $graphics=[Drawing.Graphics]::FromImage($bitmap);$hdc=$graphics.GetHdc()
        try { $captured=[JevWindowImage]::PrintWindow($handle,$hdc,2) } finally { $graphics.ReleaseHdc($hdc);$graphics.Dispose() }
        try { if (-not $captured) { Fail 'SCREENSHOT_UNAVAILABLE' };$bitmap.Save([string]$request.capture_path,[Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
        @{captured=$true} | ConvertTo-Json -Compress
        return
    }
    $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    if ($request.operation -eq 'observe') {
        $controls = @(); foreach ($element in $elements) { try { $controls += Describe $element } catch {} }
        @{environment='windows-desktop';process_id=$proc.Id;window_handle=$window.Current.NativeWindowHandle;process_started=$started;name=$window.Current.Name;controls=$controls} | ConvertTo-Json -Depth 12 -Compress
        return
    }
    $selected = $null
    foreach ($element in $elements) { if (($element.GetRuntimeId() -join '.') -eq $request.action.control_id) { $selected=$element;break } }
    if ($null -eq $selected -or -not $selected.Current.IsEnabled -or $selected.Current.IsOffscreen -or $selected.Current.IsPassword) { Fail 'CONTROL_UNAVAILABLE' }
    if ($request.expected_control) {
        $actual=Describe $selected
        foreach ($key in @('control_id','name','automation_id','type','value','enabled','offscreen','password')) {
            if ([string]$actual[$key] -cne [string]$request.expected_control.$key) { Fail 'STALE_SNAPSHOT' }
        }
    }
    $script:jevInputStarted=$true
    switch ($request.action.operation) {
        'invoke' { $selected.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
        'set_value' { $selected.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue([string]$request.action.value) }
        'toggle' { $selected.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Toggle() }
        'select' { $selected.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select() }
        default { Fail 'UNSUPPORTED_DESKTOP_ACTION' }
    }
    @{executed=$true} | ConvertTo-Json -Compress
} catch {
    # No raw exception, window contents or private values are written to stderr.
    [Console]::Error.WriteLine('WINDOWS_UIA_FAILURE '+$_.Exception.GetType().Name+' line '+$_.InvocationInfo.ScriptLineNumber)
    throw 'WINDOWS_UIA_FAILURE'
}

}
if (-not $Server) {
    try { Invoke-JevRequest ([Console]::In.ReadToEnd() | ConvertFrom-Json); exit 0 } catch { exit 1 }
}
while ($null -ne ($line=[Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    $message=$null
    try {
        $message=$line | ConvertFrom-Json
        $result=Invoke-JevRequest $message.request | ConvertFrom-Json
        @{id=$message.id;ok=$true;result=$result} | ConvertTo-Json -Depth 20 -Compress
    } catch {
        @{id=$message.id;ok=$false;input_started=[bool]$script:jevInputStarted;code='WINDOWS_UIA_FAILURE'} | ConvertTo-Json -Compress
    }
}
