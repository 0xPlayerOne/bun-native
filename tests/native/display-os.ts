/**
 * Independent OS display oracles shared by the macOS/Windows display fixtures
 * (#299). Nothing here loads GPUI: expected values come from NSScreen and
 * CoreGraphics through compiled helpers and osascript.
 */
import assert from 'node:assert/strict'

export async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

export type Rect = { x: number; y: number; width: number; height: number }
/** A display as GPUI's backend must report it, derived only from OS values. */
export interface ExpectedDisplay {
  id: string
  bounds: Rect
  visibleBounds: Rect
  scale: number
  primary: boolean
  /** Opaque handle the oracle uses to change this display's mode. */
  device: string
  /** macOS: the CoreGraphics global top-left origin, for moving windows onto it. */
  globalOrigin?: { x: number; y: number }
}

export const close = (a: number, b: number) => Math.abs(a - b) <= 1e-2
export function assertRect(actual: Rect | undefined, expected: Rect, context: string) {
  assert(actual, `${context}: missing`)
  for (const key of ['x', 'y', 'width', 'height'] as const)
    assert(
      close(actual[key], expected[key]),
      `${context}: ${key} ${actual[key]} != ${expected[key]}`
    )
}

/**
 * Every NSScreen as GPUI's macOS backend must report it, read by the compiled
 * AppKit/CoreGraphics oracle (macos-display-oracle.m) and cross-checked by a
 * second, interpreted NSScreen read through osascript. `keep` receives the raw
 * reads for the evidence file.
 */
export async function macScreens(
  helper: string,
  keep: (name: string, value: unknown) => void
): Promise<ExpectedDisplay[]> {
  type Screen = {
    number: number
    uuid: string | null
    frame: Rect
    visibleFrame: Rect
    backingScaleFactor: number
    cgBounds: Rect
    main: boolean
  }
  const screens = JSON.parse(await run([helper, 'screens'])) as Screen[]
  keep('nsscreenHelper', screens)
  // A second, interpreted NSScreen read through osascript must agree.
  const jxa = JSON.parse(
    await run([
      'osascript',
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  const v = s.visibleFrame;
  out.push({
    number: s.deviceDescription.objectForKey($('NSScreenNumber')).unsignedIntValue,
    frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height },
    visibleFrame: { x: v.origin.x, y: v.origin.y, width: v.size.width, height: v.size.height },
    backingScaleFactor: s.backingScaleFactor,
  });
}
JSON.stringify(out);`,
    ])
  ) as Pick<Screen, 'number' | 'frame' | 'visibleFrame' | 'backingScaleFactor'>[]
  keep('nsscreenOsascript', jxa)
  assert.equal(jxa.length, screens.length, 'osascript and AppKit see the same screens')
  for (const [index, screen] of screens.entries()) {
    const other = jxa[index]!
    assert.equal(other.number, screen.number)
    assert.equal(other.backingScaleFactor, screen.backingScaleFactor)
    assertRect(other.frame, screen.frame, 'osascript frame')
    assertRect(other.visibleFrame, screen.visibleFrame, 'osascript visibleFrame')
    // NSScreen points and CoreGraphics display bounds describe the same size.
    assert(close(screen.cgBounds.width, screen.frame.width))
    assert(close(screen.cgBounds.height, screen.frame.height))
  }
  keep('systemProfiler', JSON.parse(await run(['system_profiler', '-json', 'SPDisplaysDataType'])))
  return screens.map((screen) => {
    assert(screen.uuid, `display ${screen.number} has a CoreGraphics UUID`)
    const frame = screen.frame
    const visible = screen.visibleFrame
    return {
      id: screen.uuid.toLowerCase(),
      device: String(screen.number),
      primary: screen.main,
      scale: screen.backingScaleFactor,
      globalOrigin: { x: screen.cgBounds.x, y: screen.cgBounds.y },
      // GPUI's macOS display reports the CoreGraphics size at the origin.
      bounds: {
        x: 0,
        y: 0,
        width: screen.cgBounds.width,
        height: screen.cgBounds.height,
      },
      // AppKit is bottom-left; the work area is reported top-left within the screen.
      visibleBounds: {
        x: visible.x - frame.x,
        y: frame.y + frame.height - (visible.y + visible.height),
        width: visible.width,
        height: visible.height,
      },
    }
  })
}
