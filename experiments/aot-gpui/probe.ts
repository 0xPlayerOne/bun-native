import { dlopen, FFIType, JSCallback } from 'bun:ffi'

const libraryPath = process.argv[2]
const executablePath = process.argv[3]
const mode = process.argv[4]
if (!libraryPath || !executablePath || (mode !== 'dev' && mode !== 'aot')) {
  throw new Error('Usage: probe <native-library> <native-executable> <dev|aot>')
}

const library = dlopen(libraryPath, {
  bn_add: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u32 },
  bn_call: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
})
let callbacks = 0
const callback = new JSCallback(
  (left: number, right: number) => {
    callbacks += 1
    return left * right
  },
  { args: [FFIType.u32, FFIType.u32], returns: FFIType.u32 }
)
try {
  if (library.symbols.bn_add(19, 23) !== 42) throw new Error('Native arithmetic failed')
  if (library.symbols.bn_call(callback.ptr, 6, 7) !== 42 || callbacks !== 1) {
    throw new Error('Native synchronous callback failed')
  }
} finally {
  callback.close()
  library.close()
}

const child = Bun.spawn([executablePath], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
const output = new Response(child.stdout).text()
const input = JSON.stringify({ type: 'interop', value: 42, text: 'native \u2713' }) + '\n'
child.stdin.write(input)
child.stdin.end()
const [received, exitCode] = await Promise.all([output, child.exited])
if (received !== input || exitCode !== 0) throw new Error('Native subprocess round trip failed')

// The exact compiler documents read-only built-ins for AOT. A computed key
// exercises the runtime behavior, rather than the compiler's static diagnostic.
const original = Array.prototype.push
const key = process.argv[5] ?? 'push'
let mutationRejected = false
try {
  Object.defineProperty(Array.prototype, key, { value: () => 0 })
} catch (error) {
  mutationRejected = error instanceof TypeError
} finally {
  if (!mutationRejected) Object.defineProperty(Array.prototype, key, { value: original })
}
if (mutationRejected !== (mode === 'aot')) throw new Error('AOT runtime witness did not match mode')

console.log(
  JSON.stringify({
    mode,
    bunRevision: Bun.revision,
    ffi: 'passed',
    synchronousCallback: 'passed',
    subprocess: 'passed',
    subprocessExit: exitCode,
    aotReadonlyBuiltin: mutationRejected,
    gui: 'not-tested',
  })
)
