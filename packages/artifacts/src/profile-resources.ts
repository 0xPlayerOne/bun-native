/**
 * Per-profile resource reporting.
 *
 * Installer size, installed bytes, external runtime downloads, caches and RAM
 * are reported separately for each profile. Every figure carries its source: a
 * measurement, or an explicit "not measured" with the reason it was not
 * measured. A missing measurement is never reported as zero.
 */

export type ResourceMeasurementSource = 'measured' | 'not-measured'

export interface ResourceMeasurement {
  readonly bytes: number | null
  readonly source: ResourceMeasurementSource
  /** Why the figure is absent, when it is. */
  readonly reason?: string
}

export interface ProfileResourceReport {
  readonly profile: string
  readonly installerBytes: ResourceMeasurement
  readonly installedBytes: ResourceMeasurement
  readonly externalRuntimeDownloads: ResourceMeasurement
  readonly cacheBytes: ResourceMeasurement
  readonly residentMemoryBytes: ResourceMeasurement
  /** The profiles this report covers; a profile without measurements still reports. */
  readonly complete: boolean
}

export interface ProfileResourceInputs {
  readonly installerBytes?: number
  readonly installedBytes?: number
  readonly externalRuntimeDownloads?: number
  readonly cacheBytes?: number
  readonly residentMemoryBytes?: number
  /** Why a figure could not be measured on this host or platform. */
  readonly notMeasuredReasons?: Partial<
    Record<
      | 'installerBytes'
      | 'installedBytes'
      | 'externalRuntimeDownloads'
      | 'cacheBytes'
      | 'residentMemoryBytes',
      string
    >
  >
}

const KEYS = [
  'installerBytes',
  'installedBytes',
  'externalRuntimeDownloads',
  'cacheBytes',
  'residentMemoryBytes',
] as const

type Key = (typeof KEYS)[number]

function measurement(
  value: number | undefined,
  reason: string | undefined,
  source: string
): ResourceMeasurement {
  if (value === undefined)
    return Object.freeze({
      bytes: null,
      source: 'not-measured' as const,
      ...(reason ? { reason } : {}),
    })
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Resource measurement ${source} must be a non-negative integer`)
  return Object.freeze({ bytes: value, source: 'measured' as const })
}

/**
 * Builds the resource report for one profile. Figures that were not measured stay
 * absent with their reason; they are never replaced by an inferred zero.
 */
export function reportProfileResources(
  profile: string,
  inputs: ProfileResourceInputs = {}
): ProfileResourceReport {
  const reasons = inputs.notMeasuredReasons ?? {}
  const values: Record<Key, ResourceMeasurement> = {
    installerBytes: measurement(inputs.installerBytes, reasons.installerBytes, 'installerBytes'),
    installedBytes: measurement(inputs.installedBytes, reasons.installedBytes, 'installedBytes'),
    externalRuntimeDownloads: measurement(
      inputs.externalRuntimeDownloads,
      reasons.externalRuntimeDownloads,
      'externalRuntimeDownloads'
    ),
    cacheBytes: measurement(inputs.cacheBytes, reasons.cacheBytes, 'cacheBytes'),
    residentMemoryBytes: measurement(
      inputs.residentMemoryBytes,
      reasons.residentMemoryBytes,
      'residentMemoryBytes'
    ),
  }
  const complete = KEYS.every((key) => values[key].source === 'measured')
  return Object.freeze({
    profile,
    installerBytes: values.installerBytes,
    installedBytes: values.installedBytes,
    externalRuntimeDownloads: values.externalRuntimeDownloads,
    cacheBytes: values.cacheBytes,
    residentMemoryBytes: values.residentMemoryBytes,
    complete,
  })
}

/** A stable, reportable rendering. Absent measurements are named, not hidden. */
export function formatProfileResourceReport(report: ProfileResourceReport): string {
  const parts = KEYS.map((key) => {
    const value = report[key]
    return `${key}=${value.source === 'measured' ? `${value.bytes}` : 'not-measured'}`
  })
  return `${report.profile} ${parts.join(' ')}`
}
