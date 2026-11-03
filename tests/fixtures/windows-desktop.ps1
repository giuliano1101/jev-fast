Add-Type -AssemblyName PresentationFramework
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$window = [Windows.Window]::new()
$window.Title = 'Jev isolated desktop acceptance'
$window.Width=440; $window.Height=240
$panel=[Windows.Controls.StackPanel]::new(); $panel.Margin='20'
$testInput=[Windows.Controls.TextBox]::new(); [Windows.Automation.AutomationProperties]::SetAutomationId($testInput,'jevFixtureInput')
$button=[Windows.Controls.Button]::new(); $button.Content='Commit test'; [Windows.Automation.AutomationProperties]::SetAutomationId($button,'jevFixtureCommit')
$output=[Windows.Controls.TextBlock]::new(); $output.Text='Pending'; [Windows.Automation.AutomationProperties]::SetAutomationId($output,'jevFixtureOutput')
$button.Add_Click({$output.Text='Committed '+$testInput.Text})
$panel.Children.Add($testInput) | Out-Null; $panel.Children.Add($button) | Out-Null; $panel.Children.Add($output) | Out-Null
$window.Content=$panel
$window.Add_ContentRendered({$handle=[Windows.Interop.WindowInteropHelper]::new($window).Handle.ToInt64();[Console]::WriteLine((@{process_id=$PID;window_handle=$handle} | ConvertTo-Json -Compress))})
$timer=[Windows.Threading.DispatcherTimer]::new();$timer.Interval=[TimeSpan]::FromMinutes(10);$timer.Add_Tick({$window.Close()});$timer.Start()
$window.ShowDialog() | Out-Null
