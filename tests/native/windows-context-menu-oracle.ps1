# Independent UI Automation oracle for Windows OS context menus (#239).
# It never loads GPUI or the Bun Native host. It finds the open pop-up menu
# (a top-level window of class #32768) that has an item named -Title, reads
# its items through the accessibility tree and acts on them.
#   find    print the menu's items as JSON (waits for it)
#   invoke  invoke the item named -Name, or -Name inside the submenu -Title
#           names when -Submenu is set
#   escape  send Escape to the menu, as a user's key press does
#   absent  succeed once no such menu is open
param(
  [Parameter(Mandatory = $true)][ValidateSet('find', 'invoke', 'escape', 'absent')][string]$Command,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Name = '',
  [string]$Submenu = '',
  [int]$TimeoutMs = 8000
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -Namespace Win32 -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessageW(System.IntPtr window, uint message, System.IntPtr wparam, System.IntPtr lparam);
'@

$Root = [System.Windows.Automation.AutomationElement]::RootElement
$Scope = [System.Windows.Automation.TreeScope]

# A menu item's name is its label; a shortcut hint after a tab is the
# accelerator, not part of the name.
function Label($element) { ($element.Current.Name -split "`t")[0] }

function Items($menu) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::MenuItem)
  @($menu.FindAll($Scope::Descendants, $condition))
}

function Menus {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32768')
  @($Root.FindAll($Scope::Children, $condition))
}

function Find-Menu([string]$label) {
  foreach ($menu in Menus) {
    foreach ($item in Items $menu) { if ((Label $item) -eq $label) { return $menu } }
  }
  $null
}

function Find-Item($menu, [string]$label) {
  Items $menu | Where-Object { (Label $_) -eq $label } | Select-Object -First 1
}

function Wait-Menu([string]$label, [bool]$Present) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $menu = Find-Menu $label
    if (($null -ne $menu) -eq $Present) { return $menu }
    Start-Sleep -Milliseconds 25
  }
  $null
}

function Invoke-Item($item) {
  $pattern = $null
  if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke(); return
  }
  if ($item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    $pattern.Expand(); return
  }
  throw "menu item '$(Label $item)' can be neither invoked nor expanded"
}

if ($Command -eq 'absent') {
  $null = Wait-Menu $Title $false
  if ($null -ne (Find-Menu $Title)) { Write-Error "a menu with '$Title' is still open"; exit 1 }
  exit 0
}

$menu = Wait-Menu $Title $true
if ($null -eq $menu) {
  $open = @(Menus | ForEach-Object { @(Items $_ | ForEach-Object { Label $_ }) -join ',' }) -join ' | '
  Write-Error "no open menu has an item '$Title'; open menus: $open"
  exit 1
}

switch ($Command) {
  'find' {
    $toggle = [System.Windows.Automation.TogglePattern]::Pattern
    $items = @(Items $menu | ForEach-Object {
        $state = $null
        $pattern = $null
        if ($_.TryGetCurrentPattern($toggle, [ref]$pattern)) { $state = "$($pattern.Current.ToggleState)" }
        [pscustomobject]@{
          name = Label $_
          accelerator = $_.Current.AcceleratorKey
          enabled = $_.Current.IsEnabled
          toggle = $state
        }
      })
    ConvertTo-Json -Compress -InputObject $items
  }
  'invoke' {
    if ($Submenu) {
      $parent = Find-Item $menu $Submenu
      if ($null -eq $parent) { Write-Error "submenu '$Submenu' not found"; exit 1 }
      Invoke-Item $parent
      $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
      do {
        $inner = Find-Menu $Name
        if ($null -ne $inner) { break }
        Start-Sleep -Milliseconds 25
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($null -eq $inner) { Write-Error "submenu '$Submenu' did not open"; exit 1 }
      Invoke-Item (Find-Item $inner $Name)
    } else {
      $item = Find-Item $menu $Name
      if ($null -eq $item) { Write-Error "item '$Name' not found"; exit 1 }
      Invoke-Item $item
    }
  }
  'escape' {
    # The menu loop reads its thread's keyboard messages whatever their window.
    $window = [System.IntPtr]$menu.Current.NativeWindowHandle
    $null = [Win32.Native]::PostMessageW($window, 0x0100, [System.IntPtr]0x1B, [System.IntPtr]0x00010001)
    $null = [Win32.Native]::PostMessageW($window, 0x0101, [System.IntPtr]0x1B, [System.IntPtr]::new(0xC0010001))
    'key'
  }
}
