# Independent UI Automation oracle for the Windows OS message dialog (#239).
# It never loads GPUI or the Bun Native host. It finds a task dialog among the
# desktop's top-level windows by title and reads or drives it through the
# accessibility tree, exactly as an assistive client would.
#   find    print the dialog's text and button names as JSON (waits for it)
#   invoke  press the button named -Name through its InvokePattern
#   escape  focus the dialog and send Escape
#   absent  succeed once no such dialog exists
param(
  [Parameter(Mandatory = $true)][ValidateSet('find', 'invoke', 'escape', 'absent')][string]$Command,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Name = '',
  [int]$TimeoutMs = 8000
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms

function Find-Dialog {
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $Title)),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')))
  [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Children, $condition)
}

function Wait-Dialog([bool]$Present) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $dialog = Find-Dialog
    if (($null -ne $dialog) -eq $Present) { return $dialog }
    Start-Sleep -Milliseconds 25
  }
  $null
}

function Descendants($dialog, $type) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
  @($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
    ForEach-Object { $_.Current.Name })
}

if ($Command -eq 'absent') {
  $null = Wait-Dialog $false
  if ($null -ne (Find-Dialog)) { Write-Error "dialog '$Title' is still open"; exit 1 }
  exit 0
}

function Top-Level-Windows {
  $all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
  (@($all | ForEach-Object { "$($_.Current.ClassName):$($_.Current.Name)" }) -join ' | ')
}

$dialog = Wait-Dialog $true
if ($null -eq $dialog) {
  Write-Error "dialog '$Title' did not appear; top-level windows: $(Top-Level-Windows)"
  exit 1
}

switch ($Command) {
  'find' {
    [pscustomobject]@{
      title = $dialog.Current.Name
      texts = @(Descendants $dialog ([System.Windows.Automation.ControlType]::Text))
      buttons = @(Descendants $dialog ([System.Windows.Automation.ControlType]::Button))
    } | ConvertTo-Json -Compress
  }
  'invoke' {
    $condition = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)),
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
    $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $button) { Write-Error "button '$Name' not found"; exit 1 }
    $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
  }
  'escape' {
    $dialog.SetFocus()
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  }
}
