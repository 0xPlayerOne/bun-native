# Bounded Windows keyboard and input-method controller for the screen-reader
# and IME fixtures (#241). It never loads GPUI and acts only on the top-level
# window with exactly the given title.
# `foreground TITLE` makes that window the foreground window.
# `key TITLE NAME` sends one key press and release through SendInput while that
# window is in the foreground. NAME is one of tab, shift+tab, space, return,
# end, home, left, right, shift+end, backspace, hangul, nvda+tab (Insert+Tab)
# or a single letter a-z (sent as its virtual key, so an IME composes it).
# `ime TITLE KLID` asks the window to switch to the keyboard layout KLID (for
# example 00000412, Korean) with WM_INPUTLANGCHANGEREQUEST, then opens its IME
# in native (Hangul/Kana) conversion mode through WM_IME_CONTROL, and reports
# the layout, open status and conversion mode the window's thread then has.
# `imestate TITLE` reports them without changing anything.
param(
  [Parameter(Mandatory = $true)][ValidateSet('foreground', 'key', 'ime', 'imestate')][string]$Command,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Argument = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class BunNativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string className, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayoutW(string id, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr window);

  public static INPUT Key(ushort vk, bool up, bool extended) {
    INPUT input = new INPUT();
    input.type = 1;
    input.u.ki.wVk = vk;
    input.u.ki.dwFlags = (up ? 2u : 0u) | (extended ? 1u : 0u);
    return input;
  }

  // PowerShell turns $null into "" for a string argument, and FindWindowW then
  // looks for a window class named "". Pass the null class from C# instead.
  public static IntPtr FindTopLevel(string title) {
    return FindWindowW(null, title);
  }

  public static uint Send(INPUT[] inputs) {
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

$window = [BunNativeInput]::FindTopLevel($Title)
if ($window -eq [IntPtr]::Zero) { throw "No top-level window titled $Title" }
$process = [uint32]0
$thread = [BunNativeInput]::GetWindowThreadProcessId($window, [ref]$process)

function Set-Foreground {
  if ([BunNativeInput]::GetForegroundWindow() -eq $window) { return }
  [BunNativeInput]::SetForegroundWindow($window) | Out-Null
  $deadline = (Get-Date).AddSeconds(2)
  while ([BunNativeInput]::GetForegroundWindow() -ne $window) {
    if ((Get-Date) -gt $deadline) {
      # The foreground lock lets only the foreground thread change it; join
      # that thread's input state for the one call, then detach again.
      $owner = [uint32]0
      $foregroundThread = [BunNativeInput]::GetWindowThreadProcessId([BunNativeInput]::GetForegroundWindow(), [ref]$owner)
      $self = [BunNativeInput]::GetCurrentThreadId()
      [BunNativeInput]::AttachThreadInput($self, $foregroundThread, $true) | Out-Null
      try {
        [BunNativeInput]::BringWindowToTop($window) | Out-Null
        [BunNativeInput]::SetForegroundWindow($window) | Out-Null
      } finally {
        [BunNativeInput]::AttachThreadInput($self, $foregroundThread, $false) | Out-Null
      }
      Start-Sleep -Milliseconds 200
      if ([BunNativeInput]::GetForegroundWindow() -ne $window) { throw "The window titled $Title cannot become the foreground window" }
      return
    }
    Start-Sleep -Milliseconds 20
  }
}

function Get-ImeState {
  $layout = [BunNativeInput]::GetKeyboardLayout($thread).ToInt64()
  $ime = [BunNativeInput]::ImmGetDefaultIMEWnd($window)
  $open = $null
  $mode = $null
  if ($ime -ne [IntPtr]::Zero) {
    # WM_IME_CONTROL: IMC_GETOPENSTATUS (5) and IMC_GETCONVERSIONMODE (1).
    $open = [BunNativeInput]::SendMessageW($ime, 0x283, [IntPtr]5, [IntPtr]::Zero).ToInt64()
    $mode = [BunNativeInput]::SendMessageW($ime, 0x283, [IntPtr]1, [IntPtr]::Zero).ToInt64()
  }
  return [ordered]@{
    layout = ('{0:X8}' -f ($layout -band 0xFFFFFFFF))
    language = ('{0:X4}' -f ($layout -band 0xFFFF))
    imeWindow = ($ime -ne [IntPtr]::Zero)
    open = $open
    conversionMode = $mode
  }
}

switch ($Command) {
  'foreground' {
    Set-Foreground
    ConvertTo-Json -Compress -InputObject ([ordered]@{ foreground = $Title; process = $process })
  }
  'key' {
    $extended = @{ end = 0x23; home = 0x24; left = 0x25; right = 0x27 }
    $plain = @{ tab = 0x09; space = 0x20; return = 0x0D; backspace = 0x08; hangul = 0x15 }
    $shift = $false
    $insert = $false
    $name = $Argument
    if ($name.StartsWith('shift+')) { $shift = $true; $name = $name.Substring(6) }
    if ($name.StartsWith('nvda+')) { $insert = $true; $name = $name.Substring(5) }
    $isExtended = $extended.ContainsKey($name)
    if ($isExtended) { $vk = $extended[$name] }
    elseif ($plain.ContainsKey($name)) { $vk = $plain[$name] }
    elseif ($name -cmatch '^[a-z]$') { $vk = [int][char]$name.ToUpperInvariant() }
    else { throw "Unknown key name $Argument" }
    Set-Foreground
    foreach ($held in 0x10, 0x11, 0x12, 0x2D, 0x5B, 0x5C) {
      if ([BunNativeInput]::GetAsyncKeyState($held) -band 0x8000) { throw 'A modifier key is already held; no input was sent' }
    }
    $inputs = New-Object System.Collections.Generic.List[BunNativeInput+INPUT]
    if ($insert) { $inputs.Add([BunNativeInput]::Key(0x2D, $false, $true)) }
    if ($shift) { $inputs.Add([BunNativeInput]::Key(0x10, $false, $false)) }
    $inputs.Add([BunNativeInput]::Key([uint16]$vk, $false, $isExtended))
    $inputs.Add([BunNativeInput]::Key([uint16]$vk, $true, $isExtended))
    if ($shift) { $inputs.Add([BunNativeInput]::Key(0x10, $true, $false)) }
    if ($insert) { $inputs.Add([BunNativeInput]::Key(0x2D, $true, $true)) }
    if ([BunNativeInput]::GetForegroundWindow() -ne $window) { throw 'The foreground window changed before input' }
    $sent = [BunNativeInput]::Send($inputs.ToArray())
    if ($sent -ne $inputs.Count) { throw "SendInput inserted $sent of $($inputs.Count) events" }
    ConvertTo-Json -Compress -InputObject ([ordered]@{ key = $Argument; method = 'SendInput'; events = $sent })
  }
  'ime' {
    if ($Argument -notmatch '^[0-9A-Fa-f]{8}$') { throw 'A keyboard layout identifier such as 00000412 is required' }
    Set-Foreground
    $before = Get-ImeState
    # KLF_ACTIVATE (1) loads the layout into this session; the window's own
    # thread switches to it when it handles WM_INPUTLANGCHANGEREQUEST (0x50).
    $layout = [BunNativeInput]::LoadKeyboardLayoutW($Argument, 1)
    if ($layout -eq [IntPtr]::Zero) { throw "Keyboard layout $Argument is not installed" }
    [BunNativeInput]::PostMessageW($window, 0x50, [IntPtr]::Zero, $layout) | Out-Null
    $language = ('{0:X4}' -f ($layout.ToInt64() -band 0xFFFF))
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-ImeState).language -ne $language) {
      if ((Get-Date) -gt $deadline) { throw "The window did not switch to $Argument; state $(ConvertTo-Json -Compress (Get-ImeState))" }
      Start-Sleep -Milliseconds 50
    }
    $ime = [BunNativeInput]::ImmGetDefaultIMEWnd($window)
    if ($ime -ne [IntPtr]::Zero) {
      # IMC_SETOPENSTATUS (6) open, then IMC_SETCONVERSIONMODE (2) native.
      [BunNativeInput]::SendMessageW($ime, 0x283, [IntPtr]6, [IntPtr]1) | Out-Null
      [BunNativeInput]::SendMessageW($ime, 0x283, [IntPtr]2, [IntPtr]1) | Out-Null
    }
    Start-Sleep -Milliseconds 200
    ConvertTo-Json -Compress -InputObject ([ordered]@{ requested = $Argument; before = $before; after = (Get-ImeState) })
  }
  'imestate' {
    ConvertTo-Json -Compress -InputObject (Get-ImeState)
  }
}
