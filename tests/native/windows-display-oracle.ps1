# Independent Win32 / Windows Forms display oracle for the Windows display fixture (#299).
# It never loads GPUI. `screens` reads System.Windows.Forms.Screen and the per-monitor
# effective DPI; `modes` lists a device's display modes; `set` applies one dynamically
# for the session; `restore` returns the device to its registry mode.
param(
  [Parameter(Mandatory = $true)][ValidateSet('screens', 'modes', 'set', 'restore')][string]$Command,
  [string]$Device = '',
  [int]$Width = 0,
  [int]$Height = 0
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BunNativeDisplayOracle {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("shcore.dll")]
  public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromPoint(POINT point, uint flags);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool EnumDisplaySettingsW(string device, int mode, ref DEVMODE devMode);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsExW(string device, ref DEVMODE devMode, IntPtr hwnd, int flags, IntPtr param);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int ChangeDisplaySettingsExW(string device, IntPtr devMode, IntPtr hwnd, int flags, IntPtr param);

  public static DEVMODE NewMode() {
    DEVMODE mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    return mode;
  }
}
'@

function Write-Json($value) {
  $value | ConvertTo-Json -Depth 6 -Compress | Write-Output
}

function Get-Mode([string]$name, [int]$index) {
  $mode = [BunNativeDisplayOracle]::NewMode()
  if (![BunNativeDisplayOracle]::EnumDisplaySettingsW($name, $index, [ref]$mode)) { return $null }
  return $mode
}

function Describe-Mode($mode) {
  [ordered]@{
    width = $mode.dmPelsWidth
    height = $mode.dmPelsHeight
    bitsPerPel = $mode.dmBitsPerPel
    frequency = $mode.dmDisplayFrequency
  }
}

switch ($Command) {
  'screens' {
    # Per-monitor-v2 awareness before Windows Forms loads, so geometry is physical.
    $aware = [BunNativeDisplayOracle]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
    $awareError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Add-Type -AssemblyName System.Windows.Forms
    $screens = foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
      $point = [BunNativeDisplayOracle+POINT]::new()
      $point.X = $screen.Bounds.X + [int]($screen.Bounds.Width / 2)
      $point.Y = $screen.Bounds.Y + [int]($screen.Bounds.Height / 2)
      $monitor = [BunNativeDisplayOracle]::MonitorFromPoint($point, 0)
      [uint32]$dpiX = 0
      [uint32]$dpiY = 0
      $result = [BunNativeDisplayOracle]::GetDpiForMonitor($monitor, 0, [ref]$dpiX, [ref]$dpiY)
      if ($result -ne 0) { throw "GetDpiForMonitor failed: $result" }
      [ordered]@{
        deviceName = $screen.DeviceName
        primary = $screen.Primary
        bounds = [ordered]@{ x = $screen.Bounds.X; y = $screen.Bounds.Y; width = $screen.Bounds.Width; height = $screen.Bounds.Height }
        workingArea = [ordered]@{ x = $screen.WorkingArea.X; y = $screen.WorkingArea.Y; width = $screen.WorkingArea.Width; height = $screen.WorkingArea.Height }
        dpiX = $dpiX
        dpiY = $dpiY
      }
    }
    Write-Json ([ordered]@{
      dpiAwarenessSet = $aware
      dpiAwarenessError = $awareError
      screens = @($screens)
    })
  }
  'modes' {
    if (!$Device) { throw 'modes requires -Device' }
    $current = Get-Mode $Device -1
    if (!$current) { throw "No current display mode for $Device" }
    $modes = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt 4096; $index++) {
      $mode = Get-Mode $Device $index
      if (!$mode) { break }
      $modes.Add((Describe-Mode $mode))
    }
    Write-Json ([ordered]@{ current = (Describe-Mode $current); modes = $modes.ToArray() })
  }
  'set' {
    if (!$Device -or $Width -le 0 -or $Height -le 0) { throw 'set requires -Device, -Width and -Height' }
    $current = Get-Mode $Device -1
    if (!$current) { throw "No current display mode for $Device" }
    $target = $null
    for ($index = 0; $index -lt 4096; $index++) {
      $mode = Get-Mode $Device $index
      if (!$mode) { break }
      if ($mode.dmPelsWidth -eq $Width -and $mode.dmPelsHeight -eq $Height -and `
          $mode.dmBitsPerPel -eq $current.dmBitsPerPel -and `
          $mode.dmDisplayFrequency -eq $current.dmDisplayFrequency) {
        $target = $mode
        break
      }
    }
    if (!$target) { throw "No $Width x $Height mode at the current depth and frequency" }
    # DM_PELSWIDTH | DM_PELSHEIGHT; flags 0 changes the mode dynamically for the session.
    $target.dmFields = 0x80000 -bor 0x100000
    $result = [BunNativeDisplayOracle]::ChangeDisplaySettingsExW($Device, [ref]$target, [IntPtr]::Zero, 0, [IntPtr]::Zero)
    Write-Json ([ordered]@{ result = $result; applied = (Describe-Mode $target) })
    if ($result -ne 0) { exit 2 }
  }
  'restore' {
    if (!$Device) { throw 'restore requires -Device' }
    $result = [BunNativeDisplayOracle]::ChangeDisplaySettingsExW($Device, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero)
    Write-Json ([ordered]@{ result = $result })
    if ($result -ne 0) { exit 2 }
  }
}
