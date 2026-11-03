import { ProtocolError } from './framing.ts'
import { keys, number, object } from './values.ts'

export interface ServicePolicy {
  window_display: boolean
}

interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplaySnapshot {
  bounds: DisplayBounds
  scale_factor: number
}

export function parseServicePolicy(value: unknown): ServicePolicy {
  const data = object(value)
  keys(data, ['window_display'])
  if (typeof data['window_display'] !== 'boolean')
    throw new ProtocolError(
      'Native service policy must explicitly grant or deny window display access'
    )
  return { window_display: data['window_display'] }
}

export function parseDisplaySnapshot(value: unknown): DisplaySnapshot {
  const data = object(value)
  keys(data, ['bounds', 'scale_factor'])
  const bounds = object(data['bounds'])
  keys(bounds, ['x', 'y', 'width', 'height'])
  return {
    bounds: {
      x: number(bounds['x'], 'display x', -1_048_576, 1_048_576),
      y: number(bounds['y'], 'display y', -1_048_576, 1_048_576),
      width: number(bounds['width'], 'display width', Number.MIN_VALUE, 1_048_576),
      height: number(bounds['height'], 'display height', Number.MIN_VALUE, 1_048_576),
    },
    scale_factor: number(data['scale_factor'], 'display scale factor', 0.125, 16),
  }
}
