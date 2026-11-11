import { describe, expect, test } from 'bun:test'
import {
  cpuBusyPercent,
  describeLoad,
  filetime,
  hundredNanosecondsToMs,
  MEMORY_COUNTERS_BYTES,
  PROCESS_ENTRY_BYTES,
  processEntry,
  ProcessTreeSampler,
  windowsLoad,
  workingSetBytes,
  type ProcessApi,
  type ProcessTimes,
} from '../../benchmarks/comparison/windows-processes.ts'

function entryBytes(pid: number, parent: number) {
  const bytes = new Uint8Array(PROCESS_ENTRY_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, PROCESS_ENTRY_BYTES, true)
  view.setUint32(8, pid, true)
  // th32DefaultHeapID, th32ModuleID and cntThreads lie between the two IDs.
  view.setBigUint64(16, 0xffff_ffff_ffffn, true)
  view.setUint32(28, 7, true)
  view.setUint32(32, parent, true)
  return bytes
}

type Fake = {
  pid: number
  parent: number
  creation: bigint
  user: bigint
  kernel: bigint
  workingSet: number
  exited?: boolean
  gone?: boolean
}

/** An in-memory ProcessApi: Toolhelp lists only live processes, handles outlive exit. */
function fakeApi(processes: Fake[]) {
  const handles = new Map<bigint, Fake>()
  const closed: bigint[] = []
  let next = 100n
  const api: ProcessApi = {
    entries: () =>
      processes.filter((item) => !item.exited).map(({ pid, parent }) => ({ pid, parent })),
    open(pid) {
      const item = processes.find((candidate) => candidate.pid === pid && !candidate.exited)
      if (!item || item.gone) return null
      const handle = next++
      handles.set(handle, item)
      return handle
    },
    times(handle): ProcessTimes | null {
      const item = handles.get(handle)
      return item ? { creation: item.creation, kernel: item.kernel, user: item.user } : null
    },
    workingSet(handle) {
      const item = handles.get(handle)
      return item && !item.exited ? item.workingSet : null
    },
    close(handle) {
      closed.push(handle)
      handles.delete(handle)
    },
    systemTimes: () => null,
  }
  return { api, closed, handles }
}

describe('Windows struct readers', () => {
  test('PROCESSENTRY32W yields the process and parent IDs at their x64 offsets', () => {
    expect(processEntry(entryBytes(4242, 17))).toEqual({ pid: 4242, parent: 17 })
    expect(() => processEntry(new Uint8Array(PROCESS_ENTRY_BYTES - 1))).toThrow('truncated')
  })

  test('PROCESS_MEMORY_COUNTERS yields WorkingSetSize, not the peak', () => {
    const bytes = new Uint8Array(MEMORY_COUNTERS_BYTES)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, MEMORY_COUNTERS_BYTES, true)
    view.setBigUint64(8, 900_000_000n, true) // PeakWorkingSetSize
    view.setBigUint64(16, 123_456_789n, true) // WorkingSetSize
    expect(workingSetBytes(bytes)).toBe(123_456_789)
    expect(() => workingSetBytes(bytes.subarray(0, 24))).toThrow('truncated')
  })

  test('FILETIME halves combine little-endian into 100 ns units', () => {
    const bytes = new Uint8Array(8)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 0x8000_0000, true) // dwLowDateTime
    view.setUint32(4, 1, true) // dwHighDateTime
    expect(filetime(bytes)).toBe(0x1_8000_0000n)
    expect(hundredNanosecondsToMs(15_000_000n)).toBe(1_500)
    expect(() => filetime(new Uint8Array(4))).toThrow('truncated')
  })

  test('CPU busy share counts idle time inside kernel time', () => {
    const before = { idle: 1_000n, kernel: 2_000n, user: 500n }
    // 400 idle of 1000 total (800 kernel incl. idle + 200 user): 60% busy.
    expect(cpuBusyPercent(before, { idle: 1_400n, kernel: 2_800n, user: 700n })).toBe(60)
    expect(cpuBusyPercent(before, before)).toBeNull()
    expect(cpuBusyPercent(before, { idle: 900n, kernel: 2_800n, user: 700n })).toBeNull()
    expect(describeLoad(12.345, 250, 88)).toBe('cpu busy 12.3% over 250 ms; 88 processes')
    expect(describeLoad(null, 250, null)).toBe('cpu busy unavailable')
  })

  test('windowsLoad reports the busy share between two system time readings', () => {
    const readings = [
      { idle: 0n, kernel: 0n, user: 0n },
      { idle: 750n, kernel: 900n, user: 100n },
    ]
    const { api } = fakeApi([])
    api.systemTimes = () => readings.shift() ?? null
    expect(windowsLoad(api, 1)).toBe('cpu busy 25.0% over 1 ms; 0 processes')
  })
})

describe('ProcessTreeSampler', () => {
  const root = { pid: 10, parent: 1, creation: 1_000n, user: 0n, kernel: 0n, workingSet: 50 }

  test('sums the application and its descendants, not unrelated processes', () => {
    const host = { pid: 11, parent: 10, creation: 1_100n, user: 0n, kernel: 0n, workingSet: 200 }
    const helper = { pid: 12, parent: 11, creation: 1_200n, user: 0n, kernel: 0n, workingSet: 5 }
    const other = { pid: 13, parent: 1, creation: 900n, user: 0n, kernel: 0n, workingSet: 999 }
    const { api } = fakeApi([other, helper, host, root])
    const sampler = new ProcessTreeSampler(api, 10)
    expect(sampler.sample()).toEqual({ application: 50, descendants: 205, total: 255 })
    expect(sampler.observed).toBe(3)
    sampler.close()
  })

  test('rejects a reused parent ID: a child older than the root is not ours', () => {
    // Toolhelp still lists 10 as the parent of a process created before the root.
    const orphan = { pid: 20, parent: 10, creation: 500n, user: 0n, kernel: 0n, workingSet: 400 }
    const grandchild = {
      pid: 21,
      parent: 20,
      creation: 2_000n,
      user: 0n,
      kernel: 0n,
      workingSet: 7,
    }
    const { api, closed } = fakeApi([root, orphan, grandchild])
    const sampler = new ProcessTreeSampler(api, 10)
    expect(sampler.sample()).toEqual({ application: 50, descendants: 0, total: 50 })
    expect(sampler.observed).toBe(1)
    expect(closed.length).toBe(1)
    sampler.close()
  })

  test('final CPU time includes members that exited before the root', () => {
    const host = { pid: 11, parent: 10, creation: 1_100n, user: 0n, kernel: 0n, workingSet: 200 }
    const processes: Fake[] = [{ ...root }, host]
    const { api } = fakeApi(processes)
    const sampler = new ProcessTreeSampler(api, 10)
    sampler.sample()
    Object.assign(host, { exited: true, user: 30_000_000n, kernel: 10_000_000n })
    Object.assign(processes[0]!, { user: 5_000_000n, kernel: 2_500_000n })
    // An exited host no longer appears in Toolhelp or holds a working set.
    expect(sampler.sample()).toEqual({ application: 50, descendants: 0, total: 50 })
    Object.assign(processes[0]!, { exited: true })
    expect(sampler.cpu()).toEqual({ cpuUserMs: 3_500, cpuSystemMs: 1_250 })
    sampler.close()
  })

  test('an unreadable member makes CPU time unknown rather than partial', () => {
    const host = { pid: 11, parent: 10, creation: 1_100n, user: 1n, kernel: 1n, workingSet: 200 }
    const { api, handles } = fakeApi([root, host])
    const sampler = new ProcessTreeSampler(api, 10)
    sampler.sample()
    handles.delete([...handles.keys()].at(-1)!)
    expect(sampler.cpu()).toBeNull()
    sampler.close()
  })

  test('closes every handle it opened', () => {
    const host = { pid: 11, parent: 10, creation: 1_100n, user: 0n, kernel: 0n, workingSet: 200 }
    const { api, closed, handles } = fakeApi([root, host])
    const sampler = new ProcessTreeSampler(api, 10)
    sampler.sample()
    sampler.close()
    expect(closed.length).toBe(2)
    expect(handles.size).toBe(0)
    expect(sampler.observed).toBe(0)
  })

  test('a root that cannot be opened is an error, not an empty tree', () => {
    const { api } = fakeApi([{ ...root, gone: true }])
    expect(() => new ProcessTreeSampler(api, 10)).toThrow('Cannot open the launched process 10')
    expect(() => new ProcessTreeSampler(api, 99)).toThrow('Cannot open')
  })
})
