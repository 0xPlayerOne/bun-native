# Independent UI Automation oracle for the Windows OS message dialog (#239).
# It never loads GPUI or the Bun Native host. It finds a task dialog among the
# top-level windows by class and title and reads it through the
# accessibility tree and presses its buttons by their windows.
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
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessageW(System.IntPtr window, uint message, System.IntPtr wparam, System.IntPtr lparam);
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

# The task dialog's push buttons are windows of class CCPushButton that UI
# Automation exposes as named panes without an Invoke pattern.
function Push-Buttons($dialog) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CCPushButton')
  @($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
}

function Invokables($dialog) {
  @(Push-Buttons $dialog | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
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
    $button = Push-Buttons $dialog | Where-Object { $_.Current.Name -eq $Name } | Select-Object -First 1
    if ($null -eq $button) { Write-Error "button '$Name' not found"; exit 1 }
    $handle = [System.IntPtr]$button.Current.NativeWindowHandle
    if ($handle -eq [System.IntPtr]::Zero) { Write-Error "button '$Name' has no window"; exit 1 }
    # BM_CLICK presses the button exactly as a click on it does.
    if (-not [Win32.Native]::PostMessageW($handle, 0x00F5, [System.IntPtr]::Zero, [System.IntPtr]::Zero)) {
      Write-Error "button '$Name' could not be pressed"; exit 1
    }
  }
  'escape' {
    $dialog.SetFocus()
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  }
}
