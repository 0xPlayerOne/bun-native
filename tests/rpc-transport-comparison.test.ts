import { describe, expect, test } from 'bun:test'
import {
  RPC_TRANSPORT_WORKLOAD,
  assertComparable,
  type RpcTransportCandidate,
  type RpcTransportTrial,
} from '../benchmarks/rpc-transport-comparison.ts'

function trial(candidate: RpcTransportCandidate, index: number): RpcTransportTrial {
  return {
    candidate,
    trial: index,
    handoffMs: 1,
    structuredMs: 1,
    binaryMs: 1,
    cancellationMs: 1,
    queuePeaks: { clientFrames: 1, clientBytes: 1, serverFrames: 1, serverBytes: 1 },
  }
}

describe('RPC transport comparison evidence gate', () => {
  test('pins equivalent structured, binary and cancellation workload sizes', () => {
    expect(RPC_TRANSPORT_WORKLOAD).toEqual({
      version: 1,
      structuredCalls: 100,
      structuredConcurrency: 16,
      binaryCalls: 50,
      binaryBytesPerCall: 65_536,
      cancellationCalls: 20,
      cancellationConcurrency: 1,
    })
  })

  test('refuses candidate-only, undersampled and unpaired observations', () => {
    const loopback = Array.from({ length: 5 }, (_, index) => trial('authenticated-loopback', index))
    expect(() => assertComparable(loopback)).toThrow()
    expect(() =>
      assertComparable([
        ...loopback,
        ...Array.from({ length: 4 }, (_, index) => trial('native-mediated', index)),
      ])
    ).toThrow()
    expect(() =>
      assertComparable([
        ...loopback,
        ...Array.from({ length: 5 }, (_, index) => trial('native-mediated', index + 1)),
      ])
    ).toThrow()
  })

  test('admits five independent observations with matching trial indices', () => {
    const observations = (['native-mediated', 'authenticated-loopback'] as const).flatMap(
      (candidate) => Array.from({ length: 5 }, (_, index) => trial(candidate, index))
    )
    expect(() => assertComparable(observations)).not.toThrow()
  })
})
