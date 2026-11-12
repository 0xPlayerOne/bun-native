/**
 * Windows process-tree working set, CPU time and system load for the
 * benchmark controllers (#244). Linux and macOS keep their /proc, `ps` and
 * wait4 paths; this module is used only when `process.platform` is win32.
 *
 * The controller opens a handle to the launched process right after spawning
 * it and to every descendant it later sees in a Toolhelp32 snapshot. Each
 * sample sums the working sets (resident bytes) of the tree. Because the
 * handles stay open, Windows keeps every exited member's process object, so
 * after the launch ends GetProcessTimes reports each member's final user and
 * kernel time. Their sum is the tree's CPU time: the Windows analogue of the
 * wait4 time of an application plus the descendants it reaped. Descendants
 * that start and exit between two samples are missed, as on Linux and macOS.
 *
 * The struct readers and the sampler take plain bytes or an injected API, so
 * their logic is tested on any platform; only `kernel32()` calls Windows.
 */

/** sizeof(PROCESSENTRY32W) on x64. */
export const PROCESS_ENTRY_BYTES = 568
/** sizeof(PROCESS_MEMORY_COUNTERS) on x64. */
export const MEMORY_COUNTERS_BYTES = 72

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** th32ProcessID (offset 8) and th32ParentProcessID (offset 32) of a PROCESSENTRY32W. */
export function processEntry(bytes: Uint8Array): { pid: number; parent: number } {
  if (bytes.byteLength < PROCESS_ENTRY_BYTES) throw new Error('PROCESSENTRY32W is truncated')
  const data = view(bytes)
  return { pid: data.getUint32(8, true), parent: data.getUint32(32, true) }
}

/** WorkingSetSize (offset 16) of a PROCESS_MEMORY_COUNTERS, in bytes. */
export function workingSetBytes(bytes: Uint8Array): number {
  if (bytes.byteLength < MEMORY_COUNTERS_BYTES)
    throw new Error('PROCESS_MEMORY_COUNTERS is truncated')
  return Number(view(bytes).getBigUint64(16, true))
}

/** A FILETIME (two little-endian 32-bit halves) as 100-nanosecond units. */
export function filetime(bytes: Uint8Array): bigint {
  if (bytes.byteLength < 8) throw new Error('FILETIME is truncated')
  return view(bytes).getBigUint64(0, true)
}

export function hundredNanosecondsToMs(value: bigint): number {
  return Number(value) / 10_000
}

export type SystemTimes = { idle: bigint; kernel: bigint; user: bigint }

/**
 * Percentage of all logical CPUs that were busy between two GetSystemTimes
 * readings. Kernel time includes idle time, as the API documents.
 */
export function cpuBusyPercent(before: SystemTimes, after: SystemTimes): number | null {
  const idle = after.idle - before.idle
  const total = after.kernel - before.kernel + (after.user - before.user)
  if (total <= 0n || idle < 0n || idle > total) return null
  return (Number(total - idle) / Number(total)) * 100
}

export function describeLoad(busy: number | null, intervalMs: number, processes: number | null) {
  return [
    busy === null ? 'cpu busy unavailable' : `cpu busy ${busy.toFixed(1)}% over ${intervalMs} ms`,
    processes === null ? null : `${processes} processes`,
  ]
    .filter(Boolean)
    .join('; ')
}

export type ProcessTimes = { creation: bigint; kernel: bigint; user: bigint }

/** The Windows calls the sampler needs; `kernel32()` implements it. */
export interface ProcessApi {
  /** Every process in one Toolhelp32 snapshot. */
  entries(): { pid: number; parent: number }[]
  /** A query handle, or null when the process is gone or not accessible. */
  open(pid: number): bigint | null
  times(handle: bigint): ProcessTimes | null
  /** Current working set bytes, or null once the process has exited. */
  workingSet(handle: bigint): number | null
  close(handle: bigint): void
  systemTimes(): SystemTimes | null
}

export type TreeSample = { application: number; descendants: number; total: number }

export class ProcessTreeSampler {
  private readonly members = new Map<number, bigint>()
  private readonly rootCreation: bigint

  constructor(
    private readonly api: ProcessApi,
    readonly root: number
  ) {
    const handle = api.open(root)
    const times = handle === null ? null : api.times(handle)
    if (handle === null || times === null) {
      if (handle !== null) api.close(handle)
      throw new Error(`Cannot open the launched process ${root}`)
    }
    this.members.set(root, handle)
    this.rootCreation = times.creation
  }

  /** Every process ever observed in the tree, including exited ones. */
  get observed(): number {
    return this.members.size
  }

  /**
   * Adds new descendants from one snapshot, then sums the current working
   * sets of every member observed so far.
   * Toolhelp keeps a parent's numeric ID after that parent exits, so a child
   * of an older process that once had a reused ID could look like ours. Only
   * a process created no earlier than the root is accepted, and a rejected
   * process is never used to reach further descendants.
   */
  sample(): TreeSample {
    const entries = this.api.entries()
    // Every member observed earlier stays in the tree even when its parent has
    // exited and left Toolhelp: an open handle keeps Windows from reusing that
    // member's ID, and an exited member simply contributes no working set.
    const tree = new Set(this.members.keys())
    const rejected = new Set<number>()
    for (let grew = true; grew;) {
      grew = false
      for (const { pid, parent } of entries) {
        if (tree.has(pid) || rejected.has(pid) || !tree.has(parent)) continue
        if (!this.members.has(pid) && !this.admit(pid)) {
          rejected.add(pid)
          continue
        }
        tree.add(pid)
        grew = true
      }
    }
    let application = 0
    let descendants = 0
    for (const pid of tree) {
      const bytes = this.api.workingSet(this.members.get(pid)!) ?? 0
      if (pid === this.root) application = bytes
      else descendants += bytes
    }
    return { application, descendants, total: application + descendants }
  }

  private admit(pid: number) {
    const handle = this.api.open(pid)
    if (handle === null) return false
    const times = this.api.times(handle)
    if (times === null || times.creation < this.rootCreation) {
      this.api.close(handle)
      return false
    }
    this.members.set(pid, handle)
    return true
  }

  /** Final user and kernel time of every observed member, summed. */
  cpu(): { cpuUserMs: number; cpuSystemMs: number } | null {
    let user = 0n
    let kernel = 0n
    for (const handle of this.members.values()) {
      const times = this.api.times(handle)
      if (times === null) return null
      user += times.user
      kernel += times.kernel
    }
    return { cpuUserMs: hundredNanosecondsToMs(user), cpuSystemMs: hundredNanosecondsToMs(kernel) }
  }

  close() {
    for (const handle of this.members.values()) this.api.close(handle)
    this.members.clear()
  }
}

/** System CPU busy share over `intervalMs` and the snapshot's process count. */
export function windowsLoad(api: ProcessApi, intervalMs = 250): string {
  const before = api.systemTimes()
  Bun.sleepSync(intervalMs)
  const after = api.systemTimes()
  let processes: number | null = null
  try {
    processes = api.entries().length
  } catch {
    processes = null
  }
  return describeLoad(before && after ? cpuBusyPercent(before, after) : null, intervalMs, processes)
}

const TH32CS_SNAPPROCESS = 0x2
const INVALID_HANDLE = -1n
// PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE
const QUERY_ACCESS = 0x1000 | 0x0010 | 0x100000

/** The kernel32 functions ProcessApi calls, as `bun:ffi` binds them. */
export type Kernel32Symbols = {
  CreateToolhelp32Snapshot(flags: number, pid: number): number | bigint
  Process32FirstW(snapshot: bigint, entry: Uint8Array): number
  Process32NextW(snapshot: bigint, entry: Uint8Array): number
  OpenProcess(access: number, inherit: number, pid: number): number | bigint
  GetProcessTimes(
    handle: bigint,
    creation: Uint8Array,
    exit: Uint8Array,
    kernel: Uint8Array,
    user: Uint8Array
  ): number
  K32GetProcessMemoryInfo(handle: bigint, counters: Uint8Array, size: number): number
  WaitForSingleObject(handle: bigint, milliseconds: number): number
  GetSystemTimes(idle: Uint8Array, kernel: Uint8Array, user: Uint8Array): number
  CloseHandle(handle: bigint): number
}

/** ProcessApi over bound kernel32 symbols; injectable so it is tested off Windows. */
export function processApi(symbols: Kernel32Symbols): ProcessApi {
  const handleOf = (value: number | bigint) => BigInt(value)
  return {
    entries() {
      const snapshot = handleOf(symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0))
      if (snapshot === INVALID_HANDLE || snapshot === 0n)
        throw new Error('CreateToolhelp32Snapshot failed')
      try {
        const entry = new Uint8Array(PROCESS_ENTRY_BYTES)
        view(entry).setUint32(0, PROCESS_ENTRY_BYTES, true)
        const found: { pid: number; parent: number }[] = []
        let valid = symbols.Process32FirstW(snapshot, entry)
        // A bounded scan: no host has 65,536 processes.
        // Process32NextW returns FALSE at the end of the snapshot. Its last
        // error is not read: the runtime may make other calls in between.
        for (let index = 0; index < 65_536; index++) {
          if (!valid) return found
          found.push(processEntry(entry))
          valid = symbols.Process32NextW(snapshot, entry)
        }
        throw new Error('The process snapshot exceeded its bounded scan')
      } finally {
        symbols.CloseHandle(snapshot)
      }
    },
    open(pid) {
      // Without PROCESS_VM_READ the working set is unreadable but CPU time is not.
      for (const access of [QUERY_ACCESS, QUERY_ACCESS & ~0x0010]) {
        const handle = handleOf(symbols.OpenProcess(access, 0, pid))
        if (handle !== 0n) return handle
      }
      return null
    },
    times(handle) {
      const values = Array.from({ length: 4 }, () => new Uint8Array(8))
      if (!symbols.GetProcessTimes(handle, values[0]!, values[1]!, values[2]!, values[3]!))
        return null
      return {
        creation: filetime(values[0]!),
        kernel: filetime(values[2]!),
        user: filetime(values[3]!),
      }
    },
    workingSet(handle) {
      // WAIT_OBJECT_0: the process has exited and holds no working set.
      if (symbols.WaitForSingleObject(handle, 0) === 0) return null
      const counters = new Uint8Array(MEMORY_COUNTERS_BYTES)
      view(counters).setUint32(0, MEMORY_COUNTERS_BYTES, true)
      return symbols.K32GetProcessMemoryInfo(handle, counters, MEMORY_COUNTERS_BYTES)
        ? workingSetBytes(counters)
        : null
    },
    close(handle) {
      symbols.CloseHandle(handle)
    },
    systemTimes() {
      const values = Array.from({ length: 3 }, () => new Uint8Array(8))
      if (!symbols.GetSystemTimes(values[0]!, values[1]!, values[2]!)) return null
      return {
        idle: filetime(values[0]!),
        kernel: filetime(values[1]!),
        user: filetime(values[2]!),
      }
    },
  }
}

let api: ProcessApi | undefined

/** The kernel32 implementation of ProcessApi, loaded once on Windows. */
export async function kernel32(): Promise<ProcessApi> {
  if (api) return api
  if (process.platform !== 'win32') throw new Error('kernel32 is only available on Windows')
  const { dlopen, FFIType } = await import('bun:ffi')
  const { symbols } = dlopen('kernel32.dll', {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i64 },
    Process32FirstW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
    GetProcessTimes: {
      args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    K32GetProcessMemoryInfo: {
      args: [FFIType.i64, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    WaitForSingleObject: { args: [FFIType.i64, FFIType.u32], returns: FFIType.u32 },
    GetSystemTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  })
  api = processApi(symbols as unknown as Kernel32Symbols)
  return api
}
