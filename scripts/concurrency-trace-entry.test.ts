import * as nodePath from 'node:path'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as ts from 'typescript'
import { TRIAL_ITEMS, TRIAL_LIMITS, TRIAL_READERS } from './fixtures/concurrency-trace-trial-report'

// Behavioural test of the real Electron entry, not a source-text check: the entry is transpiled and executed
// with a fake electron app, a fake process and a substituted trial module, so the ordinary path from a
// rejected trial through the written payload to the single IPC message runs for real. No Electron starts and
// no production test hook is added — the frame is bound to the entry's current imports.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entryPath = join(root, 'scripts/fixtures/concurrency-trace-electron.ts')
const CONFIG_ENV = 'SCRY_CONCURRENCY_TRACE_TRIAL_CONFIG'
const NOTIFICATION_TYPE = 'concurrency-trace-trial'
const TRIAL_FAILURE = 'R5 controlled trial failure'
const WRITE_FAILURE = 'disk is full'
const PRIVATE_ROOT = '/private/tmp/scry-entry-test/root'
const RESULT_PATH = `${PRIVATE_ROOT}/result.json`

const transpiled = ts.transpileModule(readFileSync(entryPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

type EntryFactory = (
  exports: Record<string, unknown>, require: (id: string) => unknown, module: { exports: Record<string, unknown> },
  filename: string, dirname: string, process: unknown, performance: unknown
) => void

interface EntryRun {
  messages: Array<Record<string, unknown>>
  written: Array<{ path: string, body: string }>
  stderrText: string
  exits: number[]
  pathNames: string[]
}

// Every path has to satisfy the entry's own layout check, and every import the entry really has is bound
// here; an import this harness does not know fails loudly instead of silently taking a different branch.
async function runEntry({ trialFails, writeRejects }: { trialFails: boolean, writeRejects: boolean }): Promise<EntryRun> {
  const run: EntryRun = { messages: [], written: [], stderrText: '', exits: [], pathNames: [] }
  let notified = (): void => {}
  const notificationSent = new Promise<void>(resolve => { notified = resolve })
  let ready = (): void => {}
  const readyResolved = new Promise<void>(resolve => { ready = resolve })
  const config = { limit: 4, readers: 1, items: 1000 }
  const paths = { root: PRIVATE_ROOT, home: `${PRIVATE_ROOT}/home`, userData: `${PRIVATE_ROOT}/userData`,
    sessionData: `${PRIVATE_ROOT}/sessionData`, appTemp: `${PRIVATE_ROOT}/tmp`, logs: `${PRIVATE_ROOT}/logs`,
    resultPath: RESULT_PATH }
  const fakeProcess = {
    env: { [CONFIG_ENV]: JSON.stringify({ config, paths }) }, platform: 'darwin', arch: 'arm64',
    versions: { electron: '42.10.1', node: '24.18.1', chrome: '140.0.0.0', v8: '12.4' }, connected: true,
    memoryUsage: () => ({ rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }),
    stderr: { write: (text: string) => { run.stderrText += text; return true } },
    stdout: { write: () => true },
    send: (message: Record<string, unknown>) => { run.messages.push(message); notified() },
    on: () => undefined,
    exit: (code: number) => { run.exits.push(code) }
  }
  const fakeApp = {
    setPath: (name: string) => { run.pathNames.push(name) },
    on: () => undefined,
    setActivationPolicy: () => {},
    whenReady: () => readyResolved,
    exit: (code: number) => { run.exits.push(code) }
  }
  const registered: Record<string, unknown> = {
    electron: { app: fakeApp },
    'node:path': nodePath,
    'node:fs/promises': {
      mkdir: async () => {},
      writeFile: async (path: string, body: string) => {
        if (writeRejects) throw new Error(WRITE_FAILURE)
        run.written.push({ path, body })
      }
    },
    './concurrency-trace-trial': {
      runConcurrencyTraceTrial: async () => {
        if (trialFails) throw new Error(TRIAL_FAILURE)
        return { status: 'measured', config, tasks: [] }
      }
    },
    './concurrency-trace-trial-report': { TRIAL_ITEMS, TRIAL_LIMITS, TRIAL_READERS }
  }
  const factory = runInThisContext(
    `(function (exports, require, module, __filename, __dirname, process, performance) {${transpiled}\n})`,
    { filename: entryPath }
  ) as EntryFactory
  const moduleObject = { exports: {} as Record<string, unknown> }
  factory(moduleObject.exports, (id) => {
    if (id in registered) return registered[id]
    throw new Error(`the entry imported ${id}, which this harness does not bind`)
  }, moduleObject, entryPath, dirname(entryPath), fakeProcess, performance)
  ready()
  await notificationSent
  return run
}

const payloadOf = (run: EntryRun) => {
  expect(run.written).toHaveLength(1)
  expect(run.written[0].path).toBe(RESULT_PATH)
  return JSON.parse(run.written[0].body) as Record<string, unknown>
}

describe('concurrency trace Electron entry notification', () => {
  it('sends the original trial failure with a written error result', async () => {
    const run = await runEntry({ trialFails: true, writeRejects: false })
    const payload = payloadOf(run)
    expect({ status: payload.status, error: payload.error, schema: payload.schema })
      .toEqual({ status: 'error', error: TRIAL_FAILURE, schema: 1 })
    // The message the parent validates has to agree with the payload, including the failure text.
    expect(run.messages).toHaveLength(1)
    expect(run.messages[0]).toEqual({
      type: NOTIFICATION_TYPE, schema: 1, status: 'error', resultPath: RESULT_PATH, error: TRIAL_FAILURE
    })
    // The private paths are set before anything else and the process never exits on its own.
    expect(run.pathNames).toEqual(['userData', 'sessionData', 'temp', 'logs'])
    expect(run.exits).toEqual([])
  })

  it('sends no fabricated error for a measured result', async () => {
    const run = await runEntry({ trialFails: false, writeRejects: false })
    const payload = payloadOf(run)
    expect({ status: payload.status, error: payload.error }).toEqual({ status: 'measured', error: null })
    expect(run.messages).toHaveLength(1)
    expect(run.messages[0]).toEqual({ type: NOTIFICATION_TYPE, schema: 1, status: 'measured', resultPath: RESULT_PATH })
    expect(run.messages[0]).not.toHaveProperty('error')
    expect(run.exits).toEqual([])
  })

  it('keeps an earlier trial failure when writing the result also fails', async () => {
    const run = await runEntry({ trialFails: true, writeRejects: true })
    expect(run.written).toEqual([])
    expect(run.stderrText).toContain('could not write the trial result')
    expect(run.stderrText).toContain(WRITE_FAILURE)
    expect(run.messages).toHaveLength(1)
    expect(run.messages[0]).toEqual({ type: NOTIFICATION_TYPE, schema: 1, status: 'error', error: TRIAL_FAILURE })
    expect(run.exits).toEqual([])
  })

  it('reports the write failure when the trial itself succeeded', async () => {
    const run = await runEntry({ trialFails: false, writeRejects: true })
    expect(run.written).toEqual([])
    expect(run.stderrText).toContain(WRITE_FAILURE)
    expect(run.messages).toHaveLength(1)
    expect(run.messages[0]).toEqual({ type: NOTIFICATION_TYPE, schema: 1, status: 'error', error: WRITE_FAILURE })
    expect(run.exits).toEqual([])
  })
})
