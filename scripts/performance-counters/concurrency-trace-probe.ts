import { Buffer } from 'node:buffer'
import { createHash as esmCreateHash, type Hash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { expect, it } from 'vitest'

// The shared counter contract is untyped JavaScript while these files are typechecked: load the real module
// by URL and keep a local declaration instead of widening allowJs repo-wide. Dynamic import works on the
// Node versions this repo targets, unlike require() of an ES module.
const counters = (await import(new URL('../performance-counters.mjs', import.meta.url).href)) as {
  measured: (meta: Record<string, unknown>, runs: readonly number[]) => Record<string, unknown>
  writeCollector: (name: string, observations: readonly Record<string, unknown>[]) => void
  defaultRepeats: number
}
export const measured = counters.measured
export const writeCollector = counters.writeCollector
export const defaultRepeats = counters.defaultRepeats

// Counts two real JS primitives for the concurrency trace lanes: node:crypto createHash calls with the
// bytes the returned Hash.update actually accepted, and JSON.stringify calls with the UTF-8 bytes of the
// string it returned. Nothing else is counted — native digest internals, subprocesses, other hash APIs and
// byte copies are invisible here, so these are call/byte counts, never a CPU total.
//
// Attribution is by phase: writer, production reader, and other (cell setup, the real in-process client,
// fixture encoding, oracle validation, merge and cleanup). Per-primitive totals exist so work moved from one
// bucket to another stays visible, and so no cross-primitive "all JS work" number is invented.
export type ProbePhase = 'writer' | 'reader' | 'other'
export const PROBE_PHASES: readonly ProbePhase[] = ['writer', 'reader', 'other']

export interface PrimitiveCounts {
  hashCalls: number
  hashUpdateBytes: number
  stringifyCalls: number
  stringifyBytes: number
}

export interface ProbeSample {
  phases: Record<ProbePhase, PrimitiveCounts>
  totals: PrimitiveCounts
}

export interface Probe {
  /** Counts accumulated so far. Safe to call after stop(): the numbers are already recorded. */
  read(): ProbeSample
  /** Restores both globals and the ESM builtin bindings. Idempotent, always used in a finally. */
  stop(): void
}

type CryptoExports = { createHash: typeof import('node:crypto').createHash }

const cryptoExports = createRequire(import.meta.url)('node:crypto') as CryptoExports
// Captured at module load, before this file can patch anything: a second probe while one is active would
// wrap the wrapper and silently double count, so that is refused instead of hidden.
const pristineCreateHash = cryptoExports.createHash
const pristineStringify = JSON.stringify

const emptyCounts = (): PrimitiveCounts => ({ hashCalls: 0, hashUpdateBytes: 0, stringifyCalls: 0, stringifyBytes: 0 })

// The bytes update() accepts for these arguments, including the encoding argument: '6162' with 'hex' is two
// bytes, not four characters. An input this probe cannot size is refused rather than approximated.
function acceptedUpdateBytes(args: readonly unknown[]): number {
  const [data, encoding] = args
  if (typeof data === 'string') {
    // Node decodes an encoded string before hashing: '61gg' with 'hex' reaches the hash as one byte (0x61),
    // while Buffer.byteLength reports two. Only plain UTF-8 can be sized without decoding.
    if (typeof encoding === 'string' && encoding !== 'utf8' && encoding !== 'utf-8') {
      return Buffer.from(data, encoding as BufferEncoding).byteLength
    }
    return Buffer.byteLength(data)
  }
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  throw new Error(`the crypto probe cannot size a ${typeof data} update payload`)
}

/** Start counting. `phase` is read at each call, so callers can switch buckets around a real call site. */
export function startProbe(phase: () => ProbePhase): Probe {
  if (cryptoExports.createHash !== pristineCreateHash) throw new Error('a crypto probe is already active in this process')
  if (JSON.stringify !== pristineStringify) throw new Error('JSON.stringify is already patched in this process')
  const counts: Record<ProbePhase, PrimitiveCounts> = { writer: emptyCounts(), reader: emptyCounts(), other: emptyCounts() }
  let stopped = false

  // The call is attributed to the phase that created the hash, its accepted bytes to the phase that fed it.
  const countingCreateHash = function (...args: Parameters<typeof pristineCreateHash>): Hash {
    counts[phase()].hashCalls += 1
    const real = (pristineCreateHash as unknown as (...forwarded: unknown[]) => Hash).apply(undefined, args)
    let counting: Hash
    counting = new Proxy(real, {
      get(target, property) {
        if (property === 'update') {
          return (...call: unknown[]): Hash => {
            // The native call runs first, untouched: a rejected argument must surface the real error
            // rather than this probe's sizing message, and a rejected call accepts no bytes.
            const result = (target.update as unknown as (...forwarded: unknown[]) => Hash).apply(target, call)
            counts[phase()].hashUpdateBytes += acceptedUpdateBytes(call)
            return result === target ? counting : result
          }
        }
        // Everything else stays the real Hash bound to the real instance, so digest/copy/… are untouched.
        const value = Reflect.get(target, property) as unknown
        return typeof value === 'function' ? (value as (...call: unknown[]) => unknown).bind(target) : value
      }
    })
    return counting
  } as unknown as typeof pristineCreateHash

  const countingStringify = ((...args: unknown[]): string | undefined => {
    // The call is counted before the real function runs, so undefined results and throws are still calls.
    const bucket = counts[phase()]
    bucket.stringifyCalls += 1
    const text = (pristineStringify as unknown as (...forwarded: unknown[]) => string | undefined).apply(JSON, args)
    if (typeof text === 'string') bucket.stringifyBytes += Buffer.byteLength(text)
    return text
  }) as unknown as typeof JSON.stringify

  cryptoExports.createHash = countingCreateHash
  // Named ESM imports of builtins are backed by the CommonJS exports; without this the production modules
  // would keep calling the original function.
  syncBuiltinESMExports()
  JSON.stringify = countingStringify

  return {
    read(): ProbeSample {
      const snapshot = (value: PrimitiveCounts): PrimitiveCounts => ({ ...value })
      const totals = emptyCounts()
      for (const name of PROBE_PHASES) {
        for (const key of Object.keys(totals) as (keyof PrimitiveCounts)[]) totals[key] += counts[name][key]
      }
      return { phases: { writer: snapshot(counts.writer), reader: snapshot(counts.reader), other: snapshot(counts.other) }, totals }
    },
    stop(): void {
      if (stopped) return
      stopped = true
      cryptoExports.createHash = pristineCreateHash
      JSON.stringify = pristineStringify
      syncBuiltinESMExports()
    }
  }
}

const PRIMITIVES: ReadonlyArray<{ name: string, unit: 'count' | 'bytes', key: keyof PrimitiveCounts }> = [
  { name: 'hash-calls', unit: 'count', key: 'hashCalls' },
  { name: 'hash-update-bytes', unit: 'bytes', key: 'hashUpdateBytes' },
  { name: 'stringify-calls', unit: 'count', key: 'stringifyCalls' },
  { name: 'stringify-bytes', unit: 'bytes', key: 'stringifyBytes' }
]

export interface ObservationMeta {
  scenario: string
  workload: string
  source: string
}

/** One observation per phase and primitive, plus one per-primitive total. Never a combined scalar. */
export function buildObservations(meta: ObservationMeta, samples: readonly ProbeSample[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const values = (pick: (sample: ProbeSample) => number) => samples.map(pick)
  for (const phase of PROBE_PHASES) {
    for (const primitive of PRIMITIVES) {
      rows.push(measured({ ...meta, layer: 'main', metric: `${phase}.${primitive.name}`, unit: primitive.unit },
        values((sample) => sample.phases[phase][primitive.key])))
    }
  }
  for (const primitive of PRIMITIVES) {
    rows.push(measured({ ...meta, layer: 'main', metric: `total.${primitive.name}`, unit: primitive.unit },
      values((sample) => sample.totals[primitive.key])))
  }
  return rows
}

/** Integrity check for a sample: totals are the per-primitive sum of the three buckets, never a blend. */
export function totalsMatchPhases(sample: ProbeSample): boolean {
  return PRIMITIVES.every((primitive) =>
    sample.totals[primitive.key] === PROBE_PHASES.reduce((sum, name) => sum + sample.phases[name][primitive.key], 0))
}

/**
 * Known-answer control, registered by both collectors so the probe is proven in the worker that produces
 * their samples. It claims nothing about how much work production performs: an optimisation is free to
 * remove calls, and none of these assertions is made against a production path.
 */
export function registerProbeControl(): void {
  it('proves the probe observes the ESM named import without changing real output', () => {
    const text = 'scry 中文 probe ✓'
    const binary = Buffer.from([0, 1, 255, 128, 7])
    const hexValue = '6162'
    // A malformed hex pair stops decoding at the bad character, so the native update receives one byte even
    // though Buffer.byteLength reports two. The probe has to agree with the native contract, not with a guess.
    const malformedHex = '61gg'
    const payload = { text, list: [1, 2, 3], flag: true }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    // Expected values are taken with no probe installed.
    const expectedText = esmCreateHash('sha256').update(text).digest('hex')
    const expectedBinary = esmCreateHash('sha256').update(binary).digest('hex')
    const expectedHex = esmCreateHash('sha256').update(hexValue, 'hex').digest('hex')
    const expectedMalformedHex = esmCreateHash('sha256').update(malformedHex, 'hex').digest('hex')
    // Independent statement of the native contract: exactly the single byte 0x61.
    expect(expectedMalformedHex).toBe(esmCreateHash('sha256').update(Buffer.from([0x61])).digest('hex'))
    const expectedJson = JSON.stringify(payload)
    const zero: PrimitiveCounts = { hashCalls: 0, hashUpdateBytes: 0, stringifyCalls: 0, stringifyBytes: 0 }
    let phase: ProbePhase = 'writer'
    const probe = startProbe(() => phase)
    try {
      // Real results unchanged, including the encoding argument.
      expect(esmCreateHash('sha256').update(text).digest('hex')).toBe(expectedText)
      expect(esmCreateHash('sha256').update(binary).digest('hex')).toBe(expectedBinary)
      expect(esmCreateHash('sha256').update(hexValue, 'hex').digest('hex')).toBe(expectedHex)
      expect(esmCreateHash('sha256').update(malformedHex, 'hex').digest('hex')).toBe(expectedMalformedHex)
      expect(JSON.stringify(payload)).toBe(expectedJson)
      const writer = probe.read().phases.writer
      expect(writer.hashCalls).toBe(4)
      // Valid hex '6162' is two bytes, the malformed pair only one, the binary payload is its own length and
      // the text is UTF-8.
      expect(writer.hashUpdateBytes).toBe(Buffer.byteLength(text) + binary.byteLength + 2 + 1)
      expect(writer.stringifyCalls).toBe(1)
      expect(writer.stringifyBytes).toBe(Buffer.byteLength(expectedJson))
      expect(probe.read().phases.reader).toEqual(zero)

      phase = 'reader'
      // undefined and a throwing input are counted as calls without inventing bytes, and the real
      // result/error behaviour is unchanged.
      expect(JSON.stringify(undefined)).toBeUndefined()
      expect(() => JSON.stringify(cyclic)).toThrow(TypeError)
      expect(JSON.stringify(payload)).toBe(expectedJson)
      expect(JSON.stringify(payload)).toBe(expectedJson)
      // Repeated hashing grows the reader bucket by exactly the repeated work.
      esmCreateHash('sha256').update(text).digest('hex')
      esmCreateHash('sha256').update(text).digest('hex')
      const afterReader = probe.read()
      expect(afterReader.phases.reader.stringifyCalls).toBe(4)
      expect(afterReader.phases.reader.stringifyBytes).toBe(2 * Buffer.byteLength(expectedJson))
      expect(afterReader.phases.reader.hashCalls).toBe(2)
      expect(afterReader.phases.writer).toEqual(writer)
      expect(totalsMatchPhases(afterReader)).toBe(true)
      // A rejected input keeps the native error, and no accepted bytes are invented for it.
      phase = 'other'
      const beforeInvalid = probe.read().phases.other
      const invalidHash = esmCreateHash('sha256')
      let invalidError: unknown = null
      try {
        Reflect.apply(invalidHash.update as unknown as (...forwarded: unknown[]) => Hash, invalidHash, [null])
      } catch (caught) {
        invalidError = caught
      }
      expect((invalidError as { code?: string } | null)?.code).toBe('ERR_INVALID_ARG_TYPE')
      const afterInvalid = probe.read().phases.other
      expect(afterInvalid.hashUpdateBytes).toBe(beforeInvalid.hashUpdateBytes)
      // Only the hash creation above is a call; the rejected update added none.
      expect(afterInvalid.hashCalls).toBe(beforeInvalid.hashCalls + 1)
    } finally {
      probe.stop()
    }
    // Restored: both bindings are the originals again, and a call afterwards moves no counter.
    expect({ hash: cryptoExports.createHash === pristineCreateHash, stringify: JSON.stringify === pristineStringify })
      .toEqual({ hash: true, stringify: true })
    const settled = probe.read()
    esmCreateHash('sha256').update(text).digest('hex')
    JSON.stringify(payload)
    expect(probe.read()).toEqual(settled)
  })
}
