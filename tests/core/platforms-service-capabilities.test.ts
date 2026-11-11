import { describe, expect, test } from 'bun:test'
import { type Capability, REQUIRED_CAPABILITIES, type ServicePolicy } from '@bun-native/protocol'
import { serviceCapabilities } from '../../packages/core/src/services.ts'

/**
 * What each host build advertises when every run-time probe succeeds, as
 * docs/native-platforms.md tabulates from native/gpui-host/src/session.rs.
 * The mapping to public records is pure, so every platform's set is checked
 * on whichever OS runs the suite; only the backend names follow the actual OS.
 */
const everywhere: Capability[] = [
  ...REQUIRED_CAPABILITIES,
  'split_v1',
  'style_decoration_v1',
  'overlays_v1',
  'scroll_anchor_v1',
  'focus_v1',
  'scroll_control_v1',
  'overlay_keyboard_v1',
  'input_states_v1',
  'split_resize_v1',
  'accessibility_v1',
]
const advertised: Record<'linux' | 'macos' | 'windows', Capability[]> = {
  linux: [
    ...everywhere,
    'popup_windows_v1',
    'clipboard_text_v1',
    'global_shortcuts_v1',
    'notifications_v1',
    'filesystem_grants_v1',
    'processes_v1',
    'file_dialogs_v1',
    'drag_drop_files_v1',
  ],
  macos: [
    ...everywhere,
    'display_details_v1',
    'display_changes_v1',
    'display_identity_v1',
    'filesystem_grants_v1',
    'processes_v1',
    'drag_drop_files_v1',
    'app_menu_v1',
  ],
  windows: [
    ...everywhere,
    'display_details_v1',
    'display_changes_v1',
    'display_identity_v1',
    'filesystem_grants_v1',
    'processes_v1',
    'drag_drop_files_v1',
  ],
}

const denied: ServicePolicy = {
  window_display: false,
  clipboard_read: false,
  clipboard_write: false,
  global_shortcuts: false,
  notifications: false,
  drag_drop: false,
  filesystem_roots: [],
  processes: [],
}
const allowed: ServicePolicy = {
  window_display: true,
  clipboard_read: true,
  clipboard_write: false,
  global_shortcuts: true,
  notifications: true,
  drag_drop: true,
  filesystem_roots: [{ id: 'work', path: '/srv/work', access: 'read_write' }],
  processes: [{ id: 'sh', executable: '/bin/sh' }],
  file_dialogs: true,
}

const unsupported = { availability: 'unavailable', reason: 'unsupported_platform' }
const modalOverlay = { availability: 'available', scope: 'owned_window', backend: 'modal_overlay' }
const dropBackend =
  process.platform === 'darwin' ? 'appkit' : process.platform === 'win32' ? 'ole' : 'x11'
const filesBackend =
  process.platform === 'darwin'
    ? 'openat_walk'
    : process.platform === 'win32'
      ? 'ntcreatefile_walk'
      : 'openat2'
const processBackend = process.platform === 'win32' ? 'windows_job' : 'posix'

function availability(record: Readonly<Record<string, unknown>>): unknown {
  return record['availability']
}

describe('public service records for each platform advertisement', () => {
  test('Linux X11 exposes every optional service except display details, identity and changes', () => {
    const services = serviceCapabilities(allowed, advertised.linux)
    expect(services.windowDisplay).toEqual({
      availability: 'available',
      permission: 'allow',
      scope: 'owned_window',
      details: 'unavailable',
      identity: 'unavailable',
      changes: 'unavailable',
    })
    expect(services.clipboardText).toEqual({
      availability: 'available',
      read: 'allow',
      write: 'deny',
      scope: 'owned_window',
      backend: 'x11',
    })
    expect(services.globalShortcuts).toMatchObject({ permission: 'allow', backend: 'x11' })
    expect(services.notifications).toMatchObject({ permission: 'allow', backend: 'freedesktop' })
    expect(services.fileDialogs).toMatchObject({
      permission: 'allow',
      backend: 'xdg_desktop_portal',
    })
    expect(services.dragDrop).toEqual({
      availability: 'available',
      permission: 'allow',
      scope: 'owned_target',
      payload: 'files',
      backend: dropBackend,
    })
    expect(services.filesystemGrants).toEqual({
      availability: 'available',
      roots: { work: { access: 'read_write' } },
      scope: 'owned_window',
      backend: filesBackend,
    })
    expect(services.ptyProcess).toEqual({
      availability: 'available',
      executables: { sh: { executable: '/bin/sh' } },
      scope: 'owned_window',
      backend: processBackend,
    })
  })

  test('Linux Wayland reports display changes and identity without a work area', () => {
    const wayland = [
      ...everywhere,
      'display_changes_v1',
      'display_identity_v1',
      'notifications_v1',
      'filesystem_grants_v1',
      'processes_v1',
      'file_dialogs_v1',
    ] satisfies Capability[]
    expect(serviceCapabilities(allowed, wayland).windowDisplay).toEqual({
      availability: 'available',
      permission: 'allow',
      scope: 'owned_window',
      details: 'unavailable',
      identity: 'available',
      changes: 'available',
    })
  })

  test('macOS adds display details and changes and keeps grants, processes and drops', () => {
    const services = serviceCapabilities(allowed, advertised.macos)
    expect(services.windowDisplay).toMatchObject({
      details: 'available',
      identity: 'available',
      changes: 'available',
    })
    for (const record of [services.filesystemGrants, services.ptyProcess, services.dragDrop])
      expect(availability(record)).toBe('available')
    for (const record of [
      services.clipboardText,
      services.globalShortcuts,
      services.notifications,
      services.fileDialogs,
    ])
      expect<unknown>(record).toEqual(unsupported)
  })

  test('Windows offers display details and changes, grants, processes and file drops', () => {
    const services = serviceCapabilities(allowed, advertised.windows)
    expect(services.windowDisplay).toMatchObject({
      details: 'available',
      identity: 'available',
      changes: 'available',
    })
    for (const record of [services.dragDrop, services.filesystemGrants, services.ptyProcess])
      expect(availability(record)).toBe('available')
    for (const record of [
      services.clipboardText,
      services.globalShortcuts,
      services.notifications,
      services.fileDialogs,
      services.appMenu,
    ])
      expect<unknown>(record).toEqual(unsupported)
  })

  test('only the macOS advertisement offers the application menu bar', () => {
    expect(serviceCapabilities(allowed, advertised.macos).appMenu).toMatchObject({
      availability: 'available',
      scope: 'application',
      backend: 'appkit',
    })
    for (const platform of ['linux', 'windows'] as const)
      expect<unknown>(serviceCapabilities(allowed, advertised[platform]).appMenu).toEqual(
        unsupported
      )
  })

  test.each(Object.keys(advertised) as (keyof typeof advertised)[])(
    '%s: message dialogs use the modal overlay, and records are frozen',
    (platform) => {
      const services = serviceCapabilities(allowed, advertised[platform])
      expect<unknown>(services.messageDialogs).toEqual(modalOverlay)
      expect(Object.isFrozen(services)).toBe(true)
      for (const record of Object.values(services)) expect(Object.isFrozen(record)).toBe(true)
    }
  )

  test.each(Object.keys(advertised) as (keyof typeof advertised)[])(
    '%s: an advertised service stays denied without its launch grant',
    (platform) => {
      const services = serviceCapabilities(denied, advertised[platform])
      expect(services.windowDisplay.permission).toBe('deny')
      for (const record of [
        services.globalShortcuts,
        services.notifications,
        services.fileDialogs,
        services.dragDrop,
      ])
        if (availability(record) === 'available')
          expect(record).toMatchObject({ permission: 'deny' })
      if (services.clipboardText.availability === 'available')
        expect(services.clipboardText).toMatchObject({ read: 'deny', write: 'deny' })
      if (services.filesystemGrants.availability === 'available')
        expect(services.filesystemGrants.roots).toEqual({})
      if (services.ptyProcess.availability === 'available')
        expect(services.ptyProcess.executables).toEqual({})
    }
  )

  test('a host advertising only the required set reports every optional service unavailable', () => {
    const services = serviceCapabilities(allowed, [...REQUIRED_CAPABILITIES])
    expect(services.windowDisplay).toMatchObject({
      availability: 'available',
      permission: 'allow',
      details: 'unavailable',
      identity: 'unavailable',
      changes: 'unavailable',
    })
    for (const [name, record] of Object.entries(services))
      if (name !== 'windowDisplay') expect(availability(record)).toBe('unavailable')
  })

  test('display details, identity and changes are independent capabilities', () => {
    expect(
      serviceCapabilities(denied, [...REQUIRED_CAPABILITIES, 'display_changes_v1']).windowDisplay
    ).toMatchObject({ details: 'unavailable', identity: 'unavailable', changes: 'available' })
    expect(
      serviceCapabilities(denied, [...REQUIRED_CAPABILITIES, 'display_details_v1']).windowDisplay
    ).toMatchObject({ details: 'available', identity: 'unavailable', changes: 'unavailable' })
    expect(
      serviceCapabilities(denied, [...REQUIRED_CAPABILITIES, 'display_identity_v1']).windowDisplay
    ).toMatchObject({ details: 'unavailable', identity: 'available', changes: 'unavailable' })
  })
})
