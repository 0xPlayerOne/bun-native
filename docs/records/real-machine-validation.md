# Real-machine validation runbook (Windows and macOS)

**Status: preparation only.** Nothing in this file has been run on a physical
Windows PC or on a Mac that grants event posting. It lists what to set up, what
to run and what output counts as evidence, for the cases that
[macOS qualification](macos-qualification.md) and the issue trackers still hold
open: the Windows drive-path drop ([#303](https://github.com/0xPlayerOne/bun-native/issues/303)),
the real-click fault ([#247](https://github.com/0xPlayerOne/bun-native/issues/247)),
the macOS workspace references
([#248](https://github.com/0xPlayerOne/bun-native/issues/248),
[#250](https://github.com/0xPlayerOne/bun-native/issues/250)) and the next macOS
drag-entry failure ([#303](https://github.com/0xPlayerOne/bun-native/issues/303)).

A case passes only when its command ran on the named machine and printed the
named evidence. Anything else is recorded as **not run** with the reason. Do not
retry an unchanged failing head to turn a failure green, and do not loosen a
deadline or an assertion to match a result.

## What already exists (use it before adding anything)

| Need                                          | Existing instrument                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is CoreGraphics event posting permitted?      | `CGPreflightPostEventAccess()`, reported as `postEventAccess` by [`native-platform-macos.m`](../../scripts/quality/native-platform-macos.m); [`macos-drag-source.m`](../../tests/native/macos-drag-source.m) exits 2 without it                  |
| OS drag source, Windows and macOS             | [`windows-drag-source.cs`](../../tests/native/windows-drag-source.cs) (OLE `DoDragDrop`), [`macos-drag-source.m`](../../tests/native/macos-drag-source.m) (`NSDraggingSession`), driven by [`drag-source.ts`](../../tests/native/drag-source.ts) |
| Host trace of an AppKit drag (#303)           | `BUN_NATIVE_PHASE_TRACE`: steps `active`, `target_move`, `cleared` ([`phases.rs`](../../native/gpui-host/src/phases.rs)); set by [`drag-drop.ts`](../../tests/native/drag-drop.ts) on macOS                                                      |
| Late-entry and live-target check after a miss | `AppKit large-list entry evidence` line (`sourceEntry`, `lateEntryMs`, `currentWindow`, `activeTargets`) in `drag-drop.ts`                                                                                                                       |
| Host stack sample after a miss (#303)         | `AppKit host stack sample after the failed entry`: a one-second `sample` of the host                                                                                                                                                             |
| Fault containment with a real OS click (#247) | [`native-fault-macos.py`](../../scripts/quality/native-fault-macos.py) plus [`fault.ts`](../../tests/native/fault.ts); `--no-os-click` is the only thing that skips the click                                                                    |
| Hosted macOS and Windows drag runs            | "Development and AOT OS drag and drop through core, Solid and React" in [`native-platforms.yml`](../../.github/workflows/native-platforms.yml)                                                                                                   |

No new instrumentation is needed for the Windows drive-path drop, the click
fault or the next #303 failure. #248 and #250 are different: see
[the macOS workspace references](#macos-workspace-references-248-250).

## Common setup

- A checkout of the commit under test; record `git rev-parse HEAD`.
- The checksum-pinned Bun from `toolchain.json`, not a stock Bun:
  `node scripts/install-bun.mjs --destination <absolute dir>` and put that
  directory first on `PATH`. Then `bun install --frozen-lockfile`.
- Rust `1.98.1` (`rust-toolchain.toml` selects it) and the release host:
  `cargo build --locked --release -p bun-native-host`. Expect several minutes.
- An empty absolute evidence directory per run. Keep the whole directory.
- A logged-in, unlocked, awake interactive desktop on the machine itself, or a
  session that keeps a real display attached. Nobody touches the mouse or
  keyboard during a run: the drag sources post real pointer events.

## Windows: drive-path drop (#303)

Why: a launch root matches a dropped path lexically in the host's own syntax, so
only a Windows drive root can resolve a Windows drop. The core fixture now
declares drive roots on Windows and resolves the dropped items through them.
Hosted `windows-2022` runs it in the drag step; a physical PC adds a real
desktop, a real GPU and other drives.

**Machine:** Windows 10 or 11 x64, interactive console or RDP session that stays
connected and unlocked, display scaling noted in the report.
**Tools:** Git, Node (for `install-bun.mjs`), Rust via rustup with the MSVC build
tools, a Windows SDK containing `x64\fxc.exe` (set `GPUI_FXC_PATH` to it), and
the .NET Framework `csc.exe` (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319`).
**Permissions:** none beyond a normal user. Do not run elevated: OLE drag and
drop does not cross integrity levels.

```powershell
$e = 'C:\bn-qual\drag-win'            # empty; repeat with a second drive, e.g. D:\bn-qual\drag-win
New-Item -ItemType Directory "$e\development", "$e\aot" | Out-Null
$env:BUN_NATIVE_HOST = (Resolve-Path target\release\bun-native-host.exe).Path
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /optimize `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$e\windows-drag-source.exe" tests\native\windows-drag-source.cs
$env:BUN_NATIVE_DRAG_SOURCE = "$e\windows-drag-source.exe"
# Development mode
$env:BUN_NATIVE_DRAG_DROP_EVIDENCE = "$e\development"
$env:BUN_NATIVE_DRAG_DROP_MODE = 'development'
bun tests/native/drag-drop.ts 2>&1 | Tee-Object "$e\development\run.log"
# AOT mode
bun experiments/aot-gpui/build-window.ts --entry drag-drop --source (Get-Location) `
  --host $env:BUN_NATIVE_HOST --host-profile release --outdir "$e\pkg"
$env:BUN_NATIVE_DRAG_DROP_EVIDENCE = "$e\aot"
$env:BUN_NATIVE_DRAG_DROP_MODE = 'aot'
& "$e\pkg\drag-drop.exe" 2>&1 | Tee-Object "$e\aot\run.log"
```

For the second drive, set `$env:TEMP` and `$env:TMP` to a directory on that
drive before each run; the fixture creates its tree under the temp directory.

**Evidence that counts**

- Both logs end with `Drag and drop qualification passed: <n> outcomes`, exit 0.
- `development\drag-drop.json` and `aot\drag-drop.json` each have
  `backend: "ole"` and an `explicitResolution` outcome with `work: ["a.txt",
  "b c.txt"]`, `docs: "readme.txt"`, `outside: "path_denied"` and
  `grantRead: "alpha"`.
- Record the drive letters used, the Windows build (`winver`), the display scale
  and the SHA-256 of the host and of `windows-drag-source.exe`.
- A failure keeps its log. `path_denied` for an item that is beneath the root
  would be a real finding: record the exact dropped path and root, including
  letter case.

Not covered by this run: UNC and `\\?\` roots (refused by design), network
drives, drops from Explorer (the source is the repository's WinForms process, not
a file manager), and any case needing a second monitor.

## macOS: grant event posting once

Everything below that posts a pointer or key needs the controlling process to be
allowed to post CoreGraphics events. The check is `CGPreflightPostEventAccess()`;
the sources never request the permission, so it must be granted by hand.

1. Run the experiment from the app that will own the processes (Terminal, iTerm
   or the app that launches Claude Code). macOS attributes posting to that
   responsible app, and children inherit it.
2. In System Settings > Privacy & Security, allow that app under
   **Accessibility** (add it with the + button if absent), then quit and reopen
   it. The pane name is the expected one for posting; confirm with the check
   below rather than trusting it.
3. Check, using the existing drag source (exit 0 means allowed, 2 means not):

```sh
mkdir -p /tmp/bn-qual && cd <checkout>
xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework CoreGraphics \
  tests/native/macos-drag-source.m -o /tmp/bn-qual/macos-drag-source
/tmp/bn-qual/macos-drag-source </dev/null; echo "exit=$?"
```

Record the exit code and the macOS version. A brief floating window appears when
it is allowed.

**Machine:** Apple Silicon or Intel Mac with Xcode (including the Metal
toolchain), logged in with the screen unlocked and awake (`caffeinate -d` in
another tab), one primary display, no screen saver. No Developer ID is involved.

## macOS: real-click fault containment (#247)

Needs the permission above. The development and AOT runs each click the real
button, which parks a public callback; the driver then stops the host, queues two
batches and kills it.

```sh
cargo build --locked --release -p bun-native-host
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework CoreGraphics \
  -framework ApplicationServices \
  scripts/quality/native-platform-macos.m -o /tmp/bn-qual/native-platform-macos
export BUN_NATIVE_PLATFORM_HELPER=/tmp/bn-qual/native-platform-macos
bun experiments/aot-gpui/build-window.ts --entry fault --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --outdir /tmp/bn-qual/fault-package
python3 scripts/quality/native-fault-macos.py --output /tmp/bn-qual/fault-development \
  --mode development -- bun tests/native/fault.ts
python3 scripts/quality/native-fault-macos.py --output /tmp/bn-qual/fault-aot \
  --mode aot -- /tmp/bn-qual/fault-package/fault
```

The output directories must not exist beforehand. **Evidence that counts**, per
mode: the final JSON line has `"status": "passed"`; `result.json` has
`osClick: "required"` (not the `not-run` text), a `pointer` entry, a
`launchCallback`, SIGSTOP then SIGKILL in `signals`, `hostSurvivors: 0`, and
`application.status: "passed"` with zero ownership counters. If the helper
reports the permission as unavailable the run is **not run**, not failed.

Still not covered by this command: a real GPUI-internal panic or abort. No
instrument injects one; that stays open.

## macOS workspace references (#248, #250)

The Linux scenarios ([Solid](../../scripts/quality/native-solid-workspace-scenario.py)
and [React](../../scripts/quality/native-react-workspace-scenario.py)) run unchanged
on macOS through [`native-workspace-macos.py`](../../scripts/quality/native-workspace-macos.py).
It maps their X11 command words to the SDK helper's owned-window actions:

| Scenario word                     | macOS action in [`native-platform-macos.m`](../../scripts/quality/native-platform-macos.m)                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `click 1`                         | `click`: CoreGraphics mouse down/up after the AppKit hit-target check                                                 |
| `click --repeat N --delay D 4/5`  | `scroll`: one pointer move, then N three-line wheel events (4 up, 5 down; GPUI X11 SCROLL_LINES), each target-checked |
| `key ctrl+a`, `Return`, `Escape`… | `key`: named ANSI key code with modifier flags                                                                        |
| `type --delay D TEXT`             | `type`: printable ASCII, one key pair per character                                                                   |
| `windowsize W H`                  | `resize`: Accessibility `kAXSizeAttribute` on the owned window, keeping the frame-content insets                      |
| `alt+F4`                          | `close`: Accessibility press of the owned window's standard close button                                              |
| `getwindowgeometry`               | AppKit's titled content size for the observed Quartz frame                                                            |

Screenshots are cropped to the content and scaled to the GPUI viewport, so the
pixel checks see what an X11 client capture shows. `resize` and `close` need
the process to be trusted for Accessibility as well as event posting; the
helper never requests either and reports a missing grant as unavailable
(exit 2), not as a pass. Hosted `macos-15` runs both scenarios in development
and AOT in the "macOS Solid and React workspace references" step.

```sh
brew install imagemagick   # the pixel checks use ImageMagick, as on Linux
xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework CoreGraphics \
  -framework ApplicationServices \
  scripts/quality/native-platform-macos.m -o /tmp/bn-qual/native-platform-macos
export BUN_NATIVE_PLATFORM_HELPER=/tmp/bn-qual/native-platform-macos
bun experiments/aot-gpui/build-window.ts --entry react-workspace-flow --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --outdir /tmp/bn-qual/react-workspace-flow
python3 scripts/quality/native-workspace-macos.py --scenario react-workspace --mode aot \
  --output /tmp/bn-qual/react-workspace-aot -- /tmp/bn-qual/react-workspace-flow/react-workspace-flow
```

Use `--entry solid-workspace-flow` and `--scenario solid-workspace` for Solid,
and `bun <package>/development/application.js` for development mode.
**Evidence that counts:** the final JSON line has `"status": "passed"` and
`result.json` has `hostSurvivors: 0` and `application.status: "passed"`.
Accessibility and a PTY typed through OS input remain separate gaps
([#241](https://github.com/0xPlayerOne/bun-native/issues/241),
[#305](https://github.com/0xPlayerOne/bun-native/issues/305)).

### Long session on a physical Mac (#248, #250)

The workspace soak fixtures have a wall-clock session mode
([`workspace-session.ts`](../../tests/native/workspace-session.ts)): the fixed soak
round repeats until `BUN_NATIVE_SOAK_SECONDS` pass, with one CoreGraphics-typed
prompt or task, Return and 24 wheel notches per round through the same helper
([`workspace-os-input.ts`](../../tests/native/workspace-os-input.ts)),
and a sample (host and app RSS from `ps`, threads, open files from `lsof`,
acknowledgement and input-to-state latency) every `BUN_NATIVE_SOAK_SAMPLE_SECONDS`.
Hosted `macos-15` runs 120 s of each framework and mode in the workspace step;
that is a VM. On a physical Mac, with event posting granted to the terminal and
the helper built as above:

```sh
bun experiments/aot-gpui/build-window.ts --entry solid-workspace-soak --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --outdir /tmp/bn-qual/solid-soak
mkdir /tmp/bn-qual/solid-session-aot
BUN_NATIVE_DIAGNOSTICS_DIR=/tmp/bn-qual/solid-session-aot BUN_NATIVE_SOAK_SECONDS=1800 \
  BUN_NATIVE_SOAK_OS_INPUT=1 BUN_NATIVE_PHASE_TRACE=/tmp/bn-qual/solid-session-aot/phases.json \
  /tmp/bn-qual/solid-soak/solid-workspace-soak
python3 scripts/quality/native-solid-workspace-soak.py /tmp/bn-qual/solid-session-aot/soak-result.json \
  --long-session 1800 --phases /tmp/bn-qual/solid-session-aot/phases.json
```

Do not touch the keyboard or pointer during the run: the helper refuses to post
while a modifier or button is held, and a lost foreground fails the run. Use
`react` in place of `solid` for React, and `bun <package>/development/application.js`
for development mode. **Evidence that counts:** the checker prints its summary
and exits 0; keep `soak-result.json`, `samples.jsonl` and `phases.json`.

## macOS: next 65-file drag-entry failure (#303)

Several hosted macOS runs lost the entry of the 65-file reject trial: the AppKit
source reported `entered: true` but the host emitted no `drag_entered` (see the
issue's comments). The cause is unknown. A physical Mac has not reproduced it,
and a passing loop proves nothing about it.

**Attempt on a Mac** (needs the permission above; development mode):

```sh
xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework CoreGraphics \
  tests/native/macos-drag-source.m -o /tmp/bn-qual/macos-drag-source
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" \
  BUN_NATIVE_DRAG_SOURCE=/tmp/bn-qual/macos-drag-source BUN_NATIVE_DRAG_DROP_MODE=development
for i in $(seq 1 50); do
  e=/tmp/bn-qual/drag-$i; mkdir -p "$e"; export BUN_NATIVE_DRAG_DROP_EVIDENCE="$e"
  bun tests/native/drag-drop.ts >"$e/out.log" 2>&1 || echo "run $i failed"
done
```

Keep the load in the record: other apps open, power source, Screen Sharing or a
local display, `sw_vers`, and the host SHA-256. Hosted runners are headless VMs;
a local display is a different condition and says so.

**On a failure, read the log in this order** (everything is already printed; the
failed run's `drag-trace-<pid>.json` is also in its evidence directory):

| What the failure shows                                                               | What it means                                                                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `AppKit host drag trace` has no `active` step and the stack sample is idle           | GPUI never saw an active drag. AppKit did not call the destination, **or** GPUI's callback returned without one |
| No `active` step and the sample shows the UI thread inside a pasteboard or drag call | The host was blocked there; name the frame in the report                                                        |
| `active` present, no `target_move`                                                   | GPUI had the drag but no target handler ran: hit-test, painted frame or target registration                     |
| `active` and `target_move` present, still no `drag_entered`                          | The loss is after GPUI's handler, in the host's drop registry or event delivery                                 |
| `lateEntryMs` a number                                                               | The entry was late, not lost; compare with the healthy 0.9 to 1.5 s                                             |
| `lateEntryMs: null`                                                                  | Never delivered within the extra 10 s                                                                           |
| `currentWindow.origin` or `activeTargets` changed from the entry point/state         | A moved window or deactivated target (earlier hosted evidence ruled these out)                                  |

The first two rows share one gap: nothing distinguishes "AppKit never called
`draggingEntered:`" from "GPUI's `draggingEntered:` returned `None` or had no
event callback installed". Closing it needs a hook at the destination callback,
which lives in the pinned `gpui_macos` dependency, or a debugger breakpoint on
the host's `draggingEntered:` selector during a failing run. Neither is in the
repository, and neither has been tried.

## Evidence to send back

For each case: the commit, machine and OS version, the exact command, whether it
ran, the final status line, and the directory. Mark each as one of **passed**,
**failed** (with the log) or **not run** (with the reason).

| Case                               | Needs                               | Pass condition                                             |
| ---------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Windows drive-path drop, dev + AOT | Windows PC, one or two drives       | Both logs pass; `explicitResolution` has the values above  |
| macOS permission check             | Mac, Accessibility for the terminal | Drag source exits 0                                        |
| macOS real-click fault, dev + AOT  | The same                            | Both final lines `passed` with `osClick: "required"`       |
| macOS 65-file entry                | The same                            | A pass is not evidence; a failure carries trace and sample |
| macOS #248 and #250 workspaces     | The same, plus Accessibility        | Both final lines `passed` in each mode                     |
