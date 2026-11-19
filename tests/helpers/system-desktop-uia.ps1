param([int]$ProcessId, [string]$Name, [switch]$Invoke)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$handle = (Get-Process -Id $ProcessId).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { exit 2 }
$window = [Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $window) { exit 2 }
$named = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
$visible = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
$button = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
$query = [Windows.Automation.AndCondition]::new($named, $visible, $button)
$element = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $query)
if ($null -eq $element) { exit 2 }
if ($Invoke) {
    if (-not $element.Current.IsEnabled) { exit 2 }
    $pattern = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { exit 2 }
    $pattern.Invoke()
}
exit 0
