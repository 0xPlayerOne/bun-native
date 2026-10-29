/** Operator plan, never an automatic acceptance result. Partial cases stay not run. */
export const hardwareCases = [
  {
    id: 'K1',
    title: 'Keyboard traversal',
    status: 'not run',
    coverage:
      'Tab/Shift-Tab across controls and two independent previews; hide, clip, remove focus eligibility, close and reopen a pane.',
  },
  {
    id: 'K2',
    title: 'Pointer and overlays',
    status: 'not run',
    coverage:
      'Pointer routing, clipped edges, a real native application overlay, rapid pane resizing, and overlay closure.',
  },
  {
    id: 'I1',
    title: 'IME',
    status: 'not run',
    coverage:
      'Editable multilingual text and local composition events in all surfaces. Managed backend replacement is not implemented by this workbench.',
  },
  {
    id: 'T1',
    title: 'Selection and clipboard',
    status: 'not run',
    coverage:
      'Selection and controlled text are available. Clipboard reads, writes, grants and permission testing are unsupported by this workbench; selection alone cannot pass T1.',
  },
  {
    id: 'D1',
    title: 'Scaling and displays',
    status: 'not run',
    coverage:
      'Move/resize/fullscreen/restore on recorded physical displays. Renderer scale is diagnostic only; native menu and macOS dialog steps require observation.',
  },
  {
    id: 'A1',
    title: 'Accessibility',
    status: 'not run',
    coverage:
      'Labeled native HTML controls, previews and a nonmodal native overlay. Actual screen-reader testing is required; native menu and macOS dialog steps require observation.',
  },
  {
    id: 'L1',
    title: 'Background and restore',
    status: 'not run',
    coverage:
      'Window notifications/readback, page visibility, bounded numbered page output and a backend heartbeat. This is not the terminal-load workload or a resolution of #129.',
  },
  {
    id: 'L2',
    title: 'Suspend/resume',
    status: 'not run',
    coverage:
      'App stays open for manual suspend/resume. Record power/display configuration and recovery separately; no automated suspension.',
  },
  {
    id: 'F1',
    title: 'Failure recovery',
    status: 'unsupported',
    coverage:
      'Use the separate maintained renderer/GPU fault qualifier. No crash injection or hardware GPU transition is driven here.',
  },
  {
    id: 'E1',
    title: 'External activation',
    status: 'unsupported',
    coverage: 'No deep-link registration, OS dispatch or application-reopen adapter is included.',
  },
  {
    id: 'M1',
    title: 'Native commands and dialogs',
    status: 'not run',
    coverage:
      'A native popup menu and macOS open-file panel are available for observation. Shortcuts, status items and replacement during native UI are not included; Linux and Windows file dialogs are unsupported.',
  },
  {
    id: 'C1',
    title: 'Close and teardown',
    status: 'not run',
    coverage:
      'Close/reopen individual previews and explicitly quit the final window. The full native qualifier remains required for process/helper cleanup proof.',
  },
] as const

export function equipmentRecordTemplate() {
  return {
    schema: 1,
    kind: 'bunly-m7-operator-record',
    hardwareQualified: false,
    operator: null,
    equipment: {
      osReleaseBuild: null,
      architecture: null,
      gpuAndDriver: null,
      displays: [] as unknown[],
      primaryDisplay: null,
      powerState: null,
      keyboardLayout: null,
      locale: null,
      inputMethodFrameworkEngineVersion: null,
      screenReaderVersion: null,
      accessibilitySettings: null,
    },
    evidence: {
      preparationRecordSha256: null,
      launchRecordSha256: null,
      exactHeadNativeQualification: null,
      exportedCefChromiumIdentity: null,
      packagedBunVersionObservation: null,
      recordings: [] as unknown[],
    },
    cases: hardwareCases.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      reason: item.status === 'unsupported' ? item.coverage : 'No operator execution recorded.',
      coverage: item.coverage,
      attempts: [] as unknown[],
    })),
  }
}
