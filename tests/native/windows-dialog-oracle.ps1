# Independent UI Automation oracle for the Windows OS message dialog (#239).
# It never loads GPUI or the Bun Native host. It finds a task dialog among the
# top-level windows by class and title and reads or drives it through the
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

Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr FindWindowW(string className, string windowName);
'@

# The OS lists a dialog that has an owner under that owner, not under the
# desktop, so the top-level window is found by class and title and then
# opened as an automation element from its handle.
function Find-Dialog {
  $handle = [Win32.Native]::FindWindowW('#32770', $Title)
  if ($handle -eq [System.IntPtr]::Zero) { return $null }
  try { [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { $null }
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

# The buttons a user can press: every named element that supports Invoke.
function Invokables($dialog) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty, $true)
  @($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) |
    ForEach-Object { $_.Current.Name } | Where-Object { $_ })
}

# Diagnostics: every element under the dialog as type:class:name.
function Everything($dialog) {
  @($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition) |
    ForEach-Object { "$($_.Current.ControlType.ProgrammaticName):$($_.Current.ClassName):$($_.Current.Name)" })
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
    # The buttons are built after the window exists: wait for them.
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
      $buttons = @(Invokables $dialog)
      if ($buttons.Count -gt 0) { break }
      Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    [pscustomobject]@{
      title = $dialog.Current.Name
      texts = @(Descendants $dialog ([System.Windows.Automation.ControlType]::Text))
      buttons = $buttons
      tree = @(Everything $dialog)
    } | ConvertTo-Json -Compress
  }
  'invoke' {
    $condition = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty, $true)),
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
