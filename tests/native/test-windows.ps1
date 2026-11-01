# Read-only protocol probes. Never launch an app, inspect app content, or submit input.
$ErrorActionPreference = 'Stop'
$driver = Join-Path $PSScriptRoot '../../native/desktop-windows.ps1'
if (-not (Test-Path -LiteralPath $driver)) { throw 'Native Windows driver is not implemented' }
$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($driver, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
function Invoke-Probe([string[]]$lines, [string]$parentPid = '') {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $info.Arguments = '-NoProfile -NonInteractive -STA -File "' + (Resolve-Path -LiteralPath $driver).Path + '"'
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Remove('JEV_DESKTOP_PARENT_PID')
    if ($parentPid) { $info.EnvironmentVariables['JEV_DESKTOP_PARENT_PID'] = $parentPid }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    foreach ($line in $lines) { $process.StandardInput.WriteLine($line) }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Read-only protocol probe did not terminate on stdin EOF' }
    $output = $outTask.Result
    $errors = $errTask.Result
    Assert-True ($process.ExitCode -eq 0) ('Driver exit code: ' + $process.ExitCode + '; ' + $errors)
    Assert-True ([string]::IsNullOrEmpty($errors)) ('Unexpected stderr: ' + $errors)
    $process.Dispose()
    return @($output -split '\r?\n' | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ })
}
function Request($id, $method, $params) { return (@{id=$id;method=$method;params=$params} | ConvertTo-Json -Depth 10 -Compress) }

# Compile the same production C# and invoke only pure helpers with synthetic data.
# Loading the script with an empty stdin child below remains the runtime syntax probe;
# no AutomationElement, desktop content, or input API is invoked by these helper tests.
$source = (Get-Content -LiteralPath $driver -Raw).Replace("`r`n", "`n")
$startMarker = "-TypeDefinition @'" + "`n"
$start = $source.IndexOf($startMarker) + $startMarker.Length
$end = $source.IndexOf("`n'@", $start)
Assert-True ($start -ge $startMarker.Length -and $end -gt $start) 'Embedded native implementation must be present'
$nativeCode = $source.Substring($start, $end - $start)
$references = @('System.dll','System.Core.dll')
foreach ($assembly in @('UIAutomationClient','UIAutomationTypes','WindowsBase','System.Drawing','System.Windows.Forms')) {
    $references += [Reflection.Assembly]::LoadWithPartialName($assembly).Location
}
Add-Type -ReferencedAssemblies $references -TypeDefinition $nativeCode
$binding = [Reflection.BindingFlags]'Static,NonPublic'
$matching = [JevNativeDesktop.Driver].GetMethod('AppMatches', $binding)
Assert-True ($null -ne $matching) 'AppMatches production helper is required'
Assert-True (-not $matching.Invoke($null, @('C:\Other\App.exe','App','C:\Different\App.exe'))) 'A rooted path must never match an unrelated same-name process'
Assert-True ($matching.Invoke($null, @('C:\Other\App.exe','App','C:\Other\App.exe'))) 'An exact rooted executable path must match'
Assert-True ($matching.Invoke($null, @('App.exe','App',$null))) 'Executable names must remain launchable and resolvable'
$foreground = [JevNativeDesktop.Driver].GetMethod('ForegroundHandleMatches', $binding)
Assert-True ($null -ne $foreground) 'Foreground identity production helper is required'
Assert-True ($foreground.Invoke($null, @([IntPtr]0x100,[IntPtr]0x100))) 'The observed foreground window must match'
Assert-True (-not $foreground.Invoke($null, @([IntPtr]0x100,[IntPtr]0x200))) 'A new popup must not inherit the observed parent window identity'
$focus = [JevNativeDesktop.Driver].GetMethod('RequireInitialFocusIdentity', $binding)
Assert-True ($null -ne $focus) 'Strict initial focus identity helper is required'
$focus.Invoke($null, @('observed-value-and-bounds','observed-value-and-bounds'))
$rejected = $false
try { $focus.Invoke($null, @('observed-value-and-bounds','changed-value-or-bounds')) } catch {
    $errorNode = $_.Exception
    while ($null -ne $errorNode) { if ($errorNode -is [JevNativeDesktop.Failure] -and $errorNode.Code -eq 'STALE_OBSERVATION') { $rejected=$true; break }; $errorNode=$errorNode.InnerException }
}
Assert-True $rejected 'Initial keyboard focus label/value/bounds changes must reject the stale observation'
$pair = [JevNativeDesktop.Driver].GetMethod('PostPair', $binding)
Assert-True ($null -ne $pair) 'Paired input production helper is required'
$events = New-Object 'System.Collections.Generic.List[string]'
$parentCheck = [Action]{ $events.Add('parent') }
$down = [Action]{ $events.Add('down-focus-changes') }
$up = [Action]{ $events.Add('release') }
$cleanup = [Action]{ $events.Add('cleanup-release') }
$pair.Invoke($null, @($parentCheck,$down,$up,$cleanup))
Assert-True (($events -join ',') -eq 'parent,down-focus-changes,parent,release') 'An intentional focus change must still permit the paired release after checking the parent'
$events.Clear()
$parentCheck = [Action]{ $events.Add('parent'); if ($events.Count -gt 1) { throw 'PARENT_GONE' } }
try { $pair.Invoke($null, @($parentCheck,$down,$up,$cleanup)) } catch { }
Assert-True (($events -join ',') -eq 'parent,down-focus-changes,parent,cleanup-release') 'Losing the parent after keydown must submit only release cleanup'


$events.Clear()
$requestStop = [JevNativeDesktop.Driver].GetMethod('RequestStop', $binding)
$checkParent = [JevNativeDesktop.Driver].GetMethod('CheckParent', $binding)
$stopCheck = [Action]{ $events.Add('check'); $checkParent.Invoke($null, $null) }
$eofDown = [Action]{ $events.Add('down'); $requestStop.Invoke($null, $null) }
try { $pair.Invoke($null, @($stopCheck,$eofDown,$up,$cleanup)) } catch { }
Assert-True (($events -join ',') -eq 'check,down,check,cleanup-release') 'EOF during a held input must stop new input and release only the held key'

$requests = @(
    (Request 'status' 'status' @{}),
    (Request 'invalid' 'arbitrary_script' @{secret='PRIVATE_MARKER_MUST_NOT_ECHO'}),
    'not json',
    (Request 'after-malformed' 'status' @{})
)
foreach ($method in @('click','type_text','press_key','set_value','scroll','drag','perform_action')) {
    $requests += Request $method $method @{app=2147483647;observation_id='missing'}
}
$replies = Invoke-Probe $requests
Assert-True ($replies.Count -eq $requests.Count) 'Expected one response per JSON line'
Assert-True ($replies[0].ok -and $replies[0].result.platform -eq 'windows') ('Status must identify the actual Windows driver; read-only status reply: ' + (ConvertTo-Json -InputObject $replies[0] -Depth 8 -Compress))
Assert-True ($replies[0].result.app_inventory_scope -eq 'running') 'Inventory scope must be explicit'
Assert-True ($replies[0].result.input_requires_observation -eq $true) 'Input must require a grounded observation'
Assert-True ($replies[1].error.code -eq 'METHOD_NOT_FOUND') 'Unknown methods must be rejected'
Assert-True ($replies[2].error.code -eq 'INVALID_REQUEST') 'Malformed JSON must be rejected'
Assert-True ($replies[3].id -eq 'after-malformed' -and $replies[3].ok) 'Malformed JSON must not break following requests'
foreach ($reply in $replies[4..10]) { Assert-True ($reply.error.code -eq 'STALE_OBSERVATION') 'Missing observations must fail before app lookup or input' }
Assert-True (($replies | ConvertTo-Json -Depth 20) -notmatch 'PRIVATE_MARKER_MUST_NOT_ECHO') 'Private arguments must not be echoed'
$fenced = Invoke-Probe @((Request 'fenced' 'launch_app' @{app='JEV_NONEXISTENT_APP_FOR_READONLY_TEST'})) '2147483647'
Assert-True ($fenced[0].error.code -eq 'PARENT_GONE') 'Dead parent must fence launch before resolving any application'
Write-Output 'Windows native syntax and read-only protocol probes passed. Physical desktop acceptance was not performed.'
