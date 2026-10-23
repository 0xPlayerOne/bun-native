export const RPC_TRANSPORT_WORKLOAD = Object.freeze({
  version: 1,
  structuredCalls: 100,
  structuredConcurrency: 16,
  binaryCalls: 50,
  binaryBytesPerCall: 64 * 1024,
  cancellationCalls: 20,
  cancellationConcurrency: 1,
})

export type RpcTransportCandidate = 'native-mediated' | 'authenticated-loopback'

export interface RpcTransportTrial {
  readonly candidate: RpcTransportCandidate
  readonly trial: number
  readonly handoffMs: number
  readonly structuredMs: number
  readonly binaryMs: number
  readonly cancellationMs: number
  readonly queuePeaks: {
    readonly clientFrames: number
    readonly clientBytes: number
    readonly serverFrames: number
    readonly serverBytes: number
  }
}

/** A final comparison requires independently executed observations for both candidates. */
export function assertComparable(trials: readonly RpcTransportTrial[]): void {
  const trialSets: number[][] = []
  for (const candidate of ['native-mediated', 'authenticated-loopback'] as const) {
    const observations = trials.filter((trial) => trial.candidate === candidate)
    if (observations.length < 5 || new Set(observations.map((trial) => trial.trial)).size < 5)
      throw new Error(`Missing five independent ${candidate} transport trials`)
    trialSets.push([...new Set(observations.map((trial) => trial.trial))].sort((a, b) => a - b))
  }
  if (JSON.stringify(trialSets[0]) !== JSON.stringify(trialSets[1]))
    throw new Error('Transport candidates do not have the same independent trial indices')
}
