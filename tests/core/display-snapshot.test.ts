import { describe, expect, test } from 'bun:test'
import { type Capability, ProtocolError, REQUIRED_CAPABILITIES } from '@bun-native/protocol'
import { publicDisplaySnapshot } from '../../packages/core/src/services.ts'

const basic: Capability[] = [...REQUIRED_CAPABILITIES]
const detailed: Capability[] = [
  ...REQUIRED_CAPABILITIES,
  'display_details_v1',
  'display_identity_v1',
]
/** Linux Wayland: an identity without a work area. */
const identified: Capability[] = [...REQUIRED_CAPABILITIES, 'display_identity_v1']
/** A work area without an identity. */
const workAreaOnly: Capability[] = [...REQUIRED_CAPABILITIES, 'display_details_v1']
const bounds = { x: -1920, y: 0, width: 1920, height: 1080 }
const visible_bounds = { x: -1920, y: 25, width: 1920, height: 1055 }
const display_uuid = '37d8832a-2d66-02ca-b9f7-8f30a301b230'

describe('public display snapshots follow the negotiated display_details_v1 and display_identity_v1 capabilities', () => {
  test('a basic host yields only bounds and scale, as a deeply frozen copy', () => {
    const native = { bounds: { ...bounds }, scale_factor: 1.5 }
    const snapshot = publicDisplaySnapshot(native, basic)
    expect(snapshot).toEqual({ bounds, scaleFactor: 1.5 })
    expect(Object.keys(snapshot)).toEqual(['bounds', 'scaleFactor'])
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.bounds)).toBe(true)
    // A copy: later changes to the parsed wire value cannot reach the caller.
    native.bounds.width = 1
    expect(snapshot.bounds.width).toBe(1920)
  })

  test('a detailed host yields a frozen work area and display identity', () => {
    const snapshot = publicDisplaySnapshot(
      { bounds, scale_factor: 2, visible_bounds, display_uuid },
      detailed
    )
    expect(snapshot).toEqual({
      bounds,
      scaleFactor: 2,
      visibleBounds: visible_bounds,
      displayId: display_uuid,
    })
    expect(Object.isFrozen(snapshot.visibleBounds)).toBe(true)
    expect(snapshot.visibleBounds).not.toBe(visible_bounds)
  })

  test('a detailed host may omit the identity the OS did not supply', () => {
    const snapshot = publicDisplaySnapshot({ bounds, scale_factor: 1, visible_bounds }, detailed)
    expect('displayId' in snapshot).toBe(false)
    expect(snapshot.visibleBounds).toEqual(visible_bounds)
  })

  test('a detailed host must always report a work area', () => {
    expect(() => publicDisplaySnapshot({ bounds, scale_factor: 1 }, detailed)).toThrow(
      ProtocolError
    )
    expect(() =>
      publicDisplaySnapshot({ bounds, scale_factor: 1, display_uuid }, detailed)
    ).toThrow(ProtocolError)
  })

  test.each([
    ['a work area', { visible_bounds }],
    ['a display identity', { display_uuid }],
    ['both details', { visible_bounds, display_uuid }],
  ])('a host that did not advertise details cannot send %s', (_, details) => {
    expect(() => publicDisplaySnapshot({ bounds, scale_factor: 1, ...details }, basic)).toThrow(
      ProtocolError
    )
  })

  test('an identity-only host yields a display identity and no work area', () => {
    const snapshot = publicDisplaySnapshot({ bounds, scale_factor: 2, display_uuid }, identified)
    expect(snapshot).toEqual({ bounds, scaleFactor: 2, displayId: display_uuid })
    expect(Object.keys(snapshot)).toEqual(['bounds', 'scaleFactor', 'displayId'])
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  test('an identity-only host may omit an identity the platform did not supply', () => {
    expect(publicDisplaySnapshot({ bounds, scale_factor: 1 }, identified)).toEqual({
      bounds,
      scaleFactor: 1,
    })
  })

  test('an identity-only host cannot send a work area', () => {
    expect(() =>
      publicDisplaySnapshot({ bounds, scale_factor: 1, visible_bounds, display_uuid }, identified)
    ).toThrow(ProtocolError)
  })

  test('a work-area-only host cannot send a display identity', () => {
    expect(() =>
      publicDisplaySnapshot({ bounds, scale_factor: 1, visible_bounds, display_uuid }, workAreaOnly)
    ).toThrow(ProtocolError)
    expect(
      publicDisplaySnapshot({ bounds, scale_factor: 1, visible_bounds }, workAreaOnly)
    ).toEqual({ bounds, scaleFactor: 1, visibleBounds: visible_bounds })
  })

  test('display_changes_v1 alone does not admit details', () => {
    expect(() =>
      publicDisplaySnapshot({ bounds, scale_factor: 1, visible_bounds }, [
        ...basic,
        'display_changes_v1',
      ])
    ).toThrow(ProtocolError)
  })
})
