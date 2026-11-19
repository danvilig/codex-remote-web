param([int]$ProcessId, [string]$Name, [switch]$Invoke)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
$root = [Windows.Automation.AutomationElement]::RootElement
$window = $root.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
if ($null -eq $window) { exit 2 }
$named = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $named)) {
    if ($element.Current.IsOffscreen) { continue }
    if ($Invoke) {
        if (-not $element.Current.IsEnabled) { continue }
        $pattern = $null
        if (-not $element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { continue }
        $pattern.Invoke()
    }
    exit 0
}
exit 2
