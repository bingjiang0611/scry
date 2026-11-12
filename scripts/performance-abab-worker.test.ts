import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus } from 'node:os'
import { basename, join } from 'node:path'
import { performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { parseProtocolLine, protocolLine, stageKind } from './performance-abab-protocol.mjs'
import { performanceAbabHarnessFiles } from './performance-abab-harness.mjs'

// The mocks wrap the real APIs only while a measured batch is active. Fixture setup and cleanup
// are therefore excluded, while both source revisions see the identical instrumentation.
type Stage = {
  side: string
  scenario: string
  batchId: string
  kind: string
  operation: string
  durationMs: number
  startedAtMs: number
  endedAtMs: number
  provenance: 'vitest-mock-real-call'
}
type BatchContext = { side: string; scenario: string; batchId: string; startedAtMs: number; stages: Stage[]; droppedStageCount: number }
let batchContext: BatchContext | undefined
const stageLimit = 256

function recordStage(context: BatchContext | undefined, kind: string, operation: string, startedAtMs: number): void {
  if (!context) return
  const endedAtMs = performance.now()
  if (context.stages.length >= stageLimit) {
    context.droppedStageCount++
    return
  }
  context.stages.push({
    side: context.side,
    scenario: context.scenario,
    batchId: context.batchId,
    kind,
    operation,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    startedAtMs,
    endedAtMs,
    provenance: 'vitest-mock-real-call'
  })
}

function observePromise<T>(promise: Promise<T>, context: BatchContext | undefined, kind: string, operation: string, startedAtMs: number): Promise<T> {
  promise.then(() => recordStage(context, kind, operation, startedAtMs), () => recordStage(context, kind, operation, startedAtMs))
  return promise
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const wrapped = { ...actual }
  for (const operation of ['accessSync', 'appendFileSync', 'chmodSync', 'closeSync', 'existsSync', 'fsyncSync', 'lstatSync', 'mkdirSync', 'mkdtempSync', 'openSync', 'readFileSync', 'readdirSync', 'readSync', 'renameSync', 'rmSync', 'statSync', 'unlinkSync', 'writeFileSync', 'writeSync'] as const) {
    const original = actual[operation]
    Object.defineProperty(wrapped, operation, { value: (...args: unknown[]) => {
      const context = batchContext
      const startedAtMs = performance.now()
      try {
        return Reflect.apply(original, actual, args)
      } finally {
        recordStage(context, 'file-operation', operation, startedAtMs)
      }
    } })
  }
  return wrapped
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const wrapped = { ...actual } as typeof actual
  for (const operation of ['access', 'lstat', 'mkdir', 'mkdtemp', 'open', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'stat', 'writeFile'] as const) {
    const original = actual[operation]
    wrapped[operation] = ((...args: Parameters<typeof original>) => {
      const context = batchContext
      const startedAtMs = performance.now()
      return observePromise(Reflect.apply(original, actual, args), context, stageKind('fs/promises', 'file'), operation, startedAtMs)
    }) as typeof original
  }
  return wrapped
})

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const wrapped = { ...actual }
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom')
  const original = actual.execFile
  const gitOperation = (args: readonly unknown[]) => `execFile:${String(args[0])} ${Array.isArray(args[1]) ? args[1].map(String).join(' ') : ''}`
  const commandKind = (args: readonly unknown[]) => basename(String(args[0])) === 'git' ? 'git-command' : 'process-command'
  const timedExecFile = ((...args: Parameters<typeof original>) => {
    const callback = args.at(-1)
    const context = batchContext
    const startedAtMs = performance.now()
    const operation = gitOperation(args)
    if (typeof callback !== 'function') return Reflect.apply(original, actual, args)
    const next = [...args]
    next[next.length - 1] = (...callbackArgs: unknown[]) => {
      recordStage(context, commandKind(args), operation, startedAtMs)
      return Reflect.apply(callback, undefined, callbackArgs)
    }
    return Reflect.apply(original, actual, next)
  }) as typeof original & { [promisifySymbol]?: unknown }
  const originalPromisified = (original as typeof original & { [promisifySymbol]?: (...args: unknown[]) => Promise<unknown> })[promisifySymbol]
  if (originalPromisified) timedExecFile[promisifySymbol] = (...args: unknown[]) => {
    const context = batchContext
    const startedAtMs = performance.now()
    return observePromise(originalPromisified(...args), context, commandKind(args), gitOperation(args), startedAtMs)
  }
  wrapped.execFile = timedExecFile
  return wrapped
})

const harnessHash = createHash('sha256')
for (const file of performanceAbabHarnessFiles) harnessHash.update(readFileSync(file))
const harness = harnessHash.digest('hex')
const revision = process.env.SCRY_ABAB_REVISION ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const side = process.env.SCRY_ABAB_SIDE
const expectedBatches = Number(process.env.SCRY_ABAB_BATCHES ?? 20)
if (!Number.isInteger(expectedBatches) || expectedBatches < 20) throw new Error('ABAB worker requires at least 20 batches')
const socketPath = process.env.SCRY_ABAB_CONTROL_SOCKET
const readyPath = process.env.SCRY_ABAB_READY_FILE
if (!side || !socketPath || !readyPath) throw new Error('ABAB worker requires side, control socket and ready file')

const { makeFixture, scenariosFor } = await import('./performance-baseline.test.ts') as typeof import('./performance-baseline.test.ts')
type Fixture = ReturnType<typeof makeFixture>
type ScenarioMap = ReturnType<typeof scenariosFor>
type Batch = {
  scenario: string
  batchId: string
  durationMs: number
  startedAtMs: number
  endedAtMs: number
  counters: Record<string, number>
  stages: Stage[]
  droppedStageCount: number
  cpuUserMs: number
  cpuSystemMs: number
  eventLoopActiveMs: number
  eventLoopIdleMs: number
  side: string
}

let fixture: Fixture | undefined
let scenarios: ScenarioMap | undefined
const batches = new Map<string, Batch[]>()
const garbageCollections: Array<{ startedAtMs: number; durationMs: number }> = []
let droppedGarbageCollections = 0
function collectGarbageCollections(entries: PerformanceEntry[]): void {
  for (const entry of entries) {
    if (garbageCollections.length < 512) garbageCollections.push({ startedAtMs: entry.startTime, durationMs: entry.duration })
    else droppedGarbageCollections++
  }
}
const gcObserver = new PerformanceObserver(list => collectGarbageCollections(list.getEntries()))

type Request = { id: number; op: 'batch' | 'finish'; scenario?: string; batchId?: string; output?: string }
type Response = { id: number; ok: boolean; value?: unknown; error?: string }

function response(socket: import('node:net').Socket, value: Response): void {
  socket.write(protocolLine(value))
}

async function runBatch(request: Request): Promise<Batch> {
  if (!fixture || !scenarios || request.op !== 'batch' || !request.scenario || !request.batchId) throw new Error('Invalid batch request')
  const scenario = scenarios[request.scenario]
  if (!scenario) throw new Error(`Unknown ABAB scenario: ${request.scenario}`)
  const existing = batches.get(request.scenario) ?? []
  if (existing.length >= expectedBatches) throw new Error(`ABAB sample count exceeded ${expectedBatches}: ${request.scenario}`)
  if (existing.some(batch => batch.batchId === request.batchId)) throw new Error(`Duplicate ABAB batch: ${request.batchId}`)
  const cpuBefore = process.cpuUsage()
  const loopBefore = performance.eventLoopUtilization()
  const startedAtMs = performance.now()
  const context: BatchContext = { side, scenario: request.scenario, batchId: request.batchId, startedAtMs, stages: [], droppedStageCount: 0 }
  batchContext = context
  let counters: Record<string, number> | undefined
  try {
    for (let iteration = 0; iteration < scenario.iterations; iteration++) counters = await scenario.run()
  } finally {
    batchContext = undefined
  }
  const endedAtMs = performance.now()
  const cpu = process.cpuUsage(cpuBefore)
  const loop = performance.eventLoopUtilization(loopBefore)
  if (!counters) throw new Error(`ABAB scenario returned no counters: ${request.scenario}`)
  if (existing.length) expect(counters).toEqual(existing.at(-1)!.counters)
  return {
    scenario: request.scenario, batchId: request.batchId, side,
    durationMs: (endedAtMs - startedAtMs) / scenario.iterations, startedAtMs, endedAtMs,
    counters, stages: context.stages, droppedStageCount: context.droppedStageCount,
    cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    eventLoopActiveMs: loop.active, eventLoopIdleMs: loop.idle
  }
}

function artifact(): Record<string, unknown> {
  const results: Record<string, unknown> = {}
  for (const [scenario, definition] of Object.entries(scenarios ?? {})) {
    const measured = batches.get(scenario) ?? []
    const successful = measured.length === expectedBatches && measured.every(batch => Number.isFinite(batch.durationMs))
    const last = measured.at(-1)
    results[scenario] = {
      lane: definition.lane,
      workload: definition.workload,
      iterations: definition.iterations,
      warmups: definition.warmups ?? 1,
      samples: measured.length,
      counters: last?.counters ?? {},
      durationMs: measured.map(batch => batch.durationMs),
      outcome: successful ? 'completed' : 'failed'
    }
  }
  return {
    schema: 1,
    revision,
    harness,
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
    measurement: { kind: 'batch-mean-ms', warmups: 3, samples: expectedBatches, iterationsPerSample: 20, perScenario: true, interleaved: true },
    results,
    diagnostics: {
      provenance: 'real production-path calls with benchmark-only Vitest wrappers',
      timeOriginEpochMs: performance.timeOrigin,
      side,
      batches: [...batches.values()].flat(),
      garbageCollections,
      droppedGarbageCollections,
      stageDurationsAreNotExclusiveWallTime: true,
      stageCoverage: 'listed sync and async fs APIs and Git execFile calls in the benchmark worker; excludes FileHandle methods and child-internal syscalls; droppedStageCount marks capped batches'
    }
  }
}

async function finish(request: Request): Promise<void> {
  if (request.op !== 'finish' || !request.output) throw new Error('Invalid finish request')
  collectGarbageCollections(gcObserver.takeRecords())
  const output = request.output
  mkdirSync(join(output, '..'), { recursive: true })
  writeFileSync(output, JSON.stringify(artifact(), null, 2))
}

async function main(): Promise<void> {
  fixture = makeFixture()
  scenarios = scenariosFor(fixture)
  gcObserver.observe({ entryTypes: ['gc'] })
  for (const scenario of Object.values(scenarios)) {
    for (let warmup = 0; warmup < (scenario.warmups ?? 1); warmup++) {
      for (let iteration = 0; iteration < scenario.iterations; iteration++) await scenario.run()
    }
  }
  let server: ReturnType<typeof createServer> | undefined
  let finished = false
  let abortError: Error | undefined
  let requestTail = Promise.resolve()
  const closeServer = () => {
    if (server?.listening) server.close()
  }
  server = createServer(socket => {
    let buffer = ''
    socket.write(protocolLine({ id: 0, ok: true, value: { ready: true, side, revision, scenarios: Object.keys(scenarios ?? {}), harness } }))
    const enqueue = (line: string) => {
      let request: Request
      try { request = parseProtocolLine(line) as Request } catch (error) {
        abortError ??= new Error(`Invalid ABAB request: ${error instanceof Error ? error.message : String(error)}`)
        closeServer()
        socket.destroy()
        return
      }
      requestTail = requestTail.then(async () => {
        try {
          if (request.op === 'batch') {
            const batch = await runBatch(request)
            const existing = batches.get(batch.scenario) ?? []
            existing.push(batch)
            batches.set(batch.scenario, existing)
            if (!socket.destroyed) response(socket, { id: request.id, ok: true, value: { durationMs: batch.durationMs, counters: batch.counters, stages: batch.stages, droppedStageCount: batch.droppedStageCount, side: batch.side, scenario: batch.scenario, batchId: batch.batchId } })
          } else {
            await finish(request)
            finished = true
            if (!socket.destroyed) response(socket, { id: request.id, ok: true, value: { output: request.output } })
            closeServer()
            socket.end()
          }
        } catch (error) {
          if (!socket.destroyed) response(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
    }
    socket.on('data', data => {
      buffer += data.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        enqueue(line)
      }
    })
    socket.on('error', error => {
      if (!finished) abortError ??= new Error(`ABAB control socket failed: ${error.message}`)
      closeServer()
    })
    socket.on('close', () => {
      if (!finished) {
        abortError ??= new Error('ABAB controller closed the control socket before finish')
        closeServer()
      }
    })
  })
  server.listen(socketPath, () => {
    writeFileSync(readyPath, JSON.stringify({ side, socketPath, revision, harness }))
  })
  await new Promise<void>(resolve => server!.once('close', resolve))
  await requestTail
  gcObserver.disconnect()
  if (fixture) {
    const fs = await import('node:fs')
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
  if (abortError) throw abortError
}

describe('ABAB persistent benchmark worker', () => {
  it('serves the isolated benchmark over a private local socket', async () => {
    await main()
  }, 120_000)
})

afterAll(() => {
  gcObserver.disconnect()
  if (fixture) rmSync(fixture.root, { recursive: true, force: true })
})
