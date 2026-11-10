# Independent UI Automation client for the Windows accessibility fixture (#241).
# It never loads GPUI. `dump TITLE` prints the control-view subtree of the
# top-level window with that name, in pre-order, as Narrator reads it.
# `act TITLE CONTROLTYPE NAME ACTION [ARG]` performs one request on the first
# element of that control type whose name or value is NAME: `invoke`
# (InvokePattern), `focus` (SetFocus), `text S` (ValuePattern.SetValue) or
# `number N` (RangeValuePattern.SetValue). It moves no pointer and sends no keys.
param(
  [Parameter(Mandatory = $true)][ValidateSet('dump', 'act')][string]$Command,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$ControlType = '',
  [string]$Name = '',
  [string]$Action = '',
  [string]$Argument = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$automation = [System.Windows.Automation.AutomationElement]
$root = $automation::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition($automation::NameProperty, $Title)
$window = $null
$deadline = (Get-Date).AddSeconds(10)
while (-not $window) {
  $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
  if (-not $window) {
    if ((Get-Date) -gt $deadline) { throw "No top-level window named $Title" }
    Start-Sleep -Milliseconds 100
  }
}

function Get-Pattern($element, $pattern) {
  $value = $null
  if ($element.TryGetCurrentPattern($pattern, [ref]$value)) { return $value }
  return $null
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$entries = New-Object System.Collections.Generic.List[object]
$elements = New-Object System.Collections.Generic.List[object]
function Visit($element, [int]$depth) {
  if ($depth -gt 32 -or $entries.Count -gt 512) { throw 'The accessible tree exceeds the bounded fixture size' }
  if ($depth -gt 0) {
    $current = $element.Current
    $entry = [ordered]@{
      role = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      name = $current.Name
      enabled = $current.IsEnabled
      focused = $current.HasKeyboardFocus
      focusable = $current.IsKeyboardFocusable
      depth = $depth
      value = $null
      readOnly = $null
      minimum = $null
      maximum = $null
      invoke = $null -ne (Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern))
    }
    $valuePattern = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($valuePattern) {
      $entry.value = $valuePattern.Current.Value
      $entry.readOnly = $valuePattern.Current.IsReadOnly
    }
    $range = Get-Pattern $element ([System.Windows.Automation.RangeValuePattern]::Pattern)
    if ($range) {
      $entry.value = $range.Current.Value
      $entry.readOnly = $range.Current.IsReadOnly
      $entry.minimum = $range.Current.Minimum
      $entry.maximum = $range.Current.Maximum
    }
    $entries.Add([pscustomobject]$entry)
    $elements.Add($element)
  }
  $child = $walker.GetFirstChild($element)
  while ($child) {
    Visit $child ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}
Visit $window 0

if ($Command -eq 'dump') {
  ConvertTo-Json -InputObject @($entries.ToArray()) -Depth 4 -Compress
  exit 0
}

$target = $null
for ($index = 0; $index -lt $entries.Count; $index++) {
  $entry = $entries[$index]
  if ($entry.role -eq $ControlType -and ($entry.name -eq $Name -or "$($entry.value)" -eq $Name)) {
    $target = $elements[$index]
    break
  }
}
if (-not $target) { throw "No $ControlType named $Name" }
switch ($Action) {
  'invoke' { (Get-Pattern $target ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() }
  'focus' { $target.SetFocus() }
  'text' { (Get-Pattern $target ([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($Argument) }
  'number' {
    (Get-Pattern $target ([System.Windows.Automation.RangeValuePattern]::Pattern)).SetValue(
      [double]::Parse($Argument, [System.Globalization.CultureInfo]::InvariantCulture))
  }
  default { throw "Unknown action $Action" }
}
ConvertTo-Json -Compress -InputObject ([ordered]@{ role = $ControlType; name = $Name; action = $Action; done = $true })
