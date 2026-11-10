# Independent oracle for Windows OS context menus (#239). It never loads
# GPUI or the Bun Native host. It finds the open pop-up menu (a visible
# top-level window of class #32768) that has an item named -Title, reads the
# menu's items from its menu handle (MN_GETHMENU, GetMenuString and
# GetMenuState) and acts on it with real key messages, as a user's keyboard
# does: the menu loop reads its thread's keyboard input whatever its window.
#   find    print the menu's items as JSON (waits for it)
#   invoke  choose the item named -Name, or -Name inside the submenu named
#           -Submenu, with arrow keys and Enter
#   escape  send Escape to the menu
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

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PopupMenus {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr menu, uint item, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetMenuStringW(IntPtr menu, uint item, StringBuilder text, int size, uint flags);

    const uint MN_GETHMENU = 0x01E1;
    const uint MF_BYPOSITION = 0x400;
    const uint MF_GRAYED = 0x1, MF_DISABLED = 0x2, MF_CHECKED = 0x8, MF_POPUP = 0x10, MF_SEPARATOR = 0x800;

    public class Item {
        public string Name; public string Accelerator; public bool Enabled; public bool Checked;
        public bool Separator; public bool Submenu;
    }

    /// Visible pop-up menu windows, topmost first.
    public static List<IntPtr> Windows() {
        var found = new List<IntPtr>();
        EnumWindows((window, data) => {
            var name = new StringBuilder(64);
            GetClassNameW(window, name, 64);
            if (name.ToString() == "#32768" && IsWindowVisible(window)) found.Add(window);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static List<Item> Items(IntPtr window) {
        var items = new List<Item>();
        IntPtr menu = SendMessageW(window, MN_GETHMENU, IntPtr.Zero, IntPtr.Zero);
        if (menu == IntPtr.Zero) return items;
        int count = GetMenuItemCount(menu);
        for (uint index = 0; index < count; index++) {
            uint state = GetMenuState(menu, index, MF_BYPOSITION);
            var text = new StringBuilder(256);
            GetMenuStringW(menu, index, text, 256, MF_BYPOSITION);
            string[] parts = text.ToString().Split('\t');
            items.Add(new Item {
                Name = parts[0],
                Accelerator = parts.Length > 1 ? parts[1] : "",
                Enabled = (state & (MF_GRAYED | MF_DISABLED)) == 0,
                Checked = (state & MF_CHECKED) != 0,
                Separator = (state & MF_SEPARATOR) != 0,
                Submenu = (state & MF_POPUP) != 0,
            });
        }
        return items;
    }

    public static void Key(IntPtr window, int key) {
        PostMessageW(window, 0x0100, (IntPtr)key, (IntPtr)1);
        PostMessageW(window, 0x0101, (IntPtr)key, unchecked((IntPtr)(int)0xC0000001));
    }
}
'@

$VK = @{ Down = 0x28; Right = 0x27; Return = 0x0D; Escape = 0x1B }

function Find-Menu([string]$label) {
  foreach ($window in [PopupMenus]::Windows()) {
    foreach ($item in [PopupMenus]::Items($window)) { if ($item.Name -eq $label) { return $window } }
  }
  $null
}

function Wait-Menu([string]$label, [bool]$Present) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $window = Find-Menu $label
    if (($null -ne $window) -eq $Present) { return $window }
    Start-Sleep -Milliseconds 25
  }
  $null
}

# Arrow-key presses from no highlight to the item named $label: separators
# are skipped by the menu loop and so are not counted.
function Steps($window, [string]$label) {
  $steps = 0
  foreach ($item in [PopupMenus]::Items($window)) {
    if ($item.Separator) { continue }
    $steps += 1
    if ($item.Name -eq $label) { return $steps }
  }
  throw "menu item '$label' not found"
}

function Press($window, [int]$key, [int]$times = 1) {
  for ($index = 0; $index -lt $times; $index++) {
    [PopupMenus]::Key($window, $key)
    Start-Sleep -Milliseconds 60
  }
}

if ($Command -eq 'absent') {
  $null = Wait-Menu $Title $false
  if ($null -ne (Find-Menu $Title)) { Write-Error "a menu with '$Title' is still open"; exit 1 }
  exit 0
}

$menu = Wait-Menu $Title $true
if ($null -eq $menu) {
  $open = @([PopupMenus]::Windows() | ForEach-Object {
      @([PopupMenus]::Items($_) | ForEach-Object { $_.Name }) -join ','
    })
  Write-Error "no open menu has an item '$Title'; $($open.Count) visible menu windows: $($open -join ' | ')"
  exit 1
}

switch ($Command) {
  'find' {
    $items = @([PopupMenus]::Items($menu) | Where-Object { -not $_.Separator } | ForEach-Object {
        [pscustomobject]@{
          name = $_.Name
          accelerator = $_.Accelerator
          enabled = $_.Enabled
          checked = $_.Checked
          submenu = $_.Submenu
        }
      })
    ConvertTo-Json -Compress -InputObject $items
  }
  'invoke' {
    if ($Submenu) {
      Press $menu $VK.Down (Steps $menu $Submenu)
      Press $menu $VK.Right
      $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
      do {
        $inner = Find-Menu $Name
        if ($null -ne $inner) { break }
        Start-Sleep -Milliseconds 25
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($null -eq $inner) { Write-Error "submenu '$Submenu' did not open"; exit 1 }
      # Opening a submenu from the keyboard highlights its first item.
      Press $inner $VK.Down ((Steps $inner $Name) - 1)
      Press $inner $VK.Return
    } else {
      Press $menu $VK.Down (Steps $menu $Name)
      Press $menu $VK.Return
    }
    'keys'
  }
  'escape' {
    Press $menu $VK.Escape
    'key'
  }
}
