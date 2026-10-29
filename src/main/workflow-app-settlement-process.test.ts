import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WorkflowProgress } from '../shared/workflow'
import { WorkflowRunSettlementStore, type WorkflowRunSettlement } from './workflow-run-settlement-store'
// Typecheck the executable child without running its top-level entry in Vitest.
import type {} from '../../scripts/fixtures/workflow-app-settlement-process'

let engineRoot = ''
let enginePath = ''
const roots: string[] = []
const children = new Set<ChildProcess>()

beforeAll(async () => {
  engineRoot = await mkdtemp(join(tmpdir(), 'scry-app-settlement-engine-'))
  enginePath = join(engineRoot, 'engine.mjs')
  await build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), '../../scripts/fixtures/workflow-app-settlement-process.ts')],
    outfile: enginePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent'
  })
})
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { if (engineRoot) await rm(engineRoot, { recursive: true, force: true }) })

function launch(root: string, mode: 'crash' | 'recover') {
  const child = spawn(process.execPath, [enginePath, root, mode], {
    env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  children.add(child)
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', text => { stderr += text })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { child, closed, stderr: () => stderr }
}

function settlementCheckpoint(child: ChildProcess, stderr: () => string) {
  return new Promise<WorkflowRunSettlement>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Settlement checkpoint timed out: ' + stderr())), 15_000)
    child.once('message', message => {
      clearTimeout(timeout)
      const value = message as { type?: string; settlement?: WorkflowRunSettlement }
      value.type === 'settlement_persisted' && value.settlement
        ? resolve(value.settlement)
        : reject(new Error('Unexpected settlement checkpoint: ' + JSON.stringify(message)))
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Settlement process exited before checkpoint (${code}): ${stderr()}`))
    })
  })
}

describe('production App terminal settlement across a killed controller', () => {
  it('cold-recovers exact settlement without replay and manually restarts from a new attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry app settlement '))
    roots.push(root)
    const crash = launch(root, 'crash')
    const settlement = await settlementCheckpoint(crash.child, crash.stderr)
    await expect(new WorkflowRunSettlementStore(root).load(settlement.attemptId)).resolves.toEqual(settlement)
    crash.child.kill('SIGKILL')
    await expect(crash.closed).resolves.toEqual({ code: null, signal: 'SIGKILL' })

    const recovery = launch(root, 'recover')
    const recoveryResult = await recovery.closed
    expect(recoveryResult, recovery.stderr()).toEqual({ code: 0, signal: null })
    const result = JSON.parse(await readFile(join(root, 'settlement-result.json'), 'utf8')) as {
      before: WorkflowProgress
      after: WorkflowProgress
      executionDispatches: number
    }
    expect(result.before).toMatchObject({ state: 'unknown', slots: { inUse: 0 } })
    expect(result.before.attempts).toEqual([expect.objectContaining({
      attemptId: settlement.attemptId,
      taskId: settlement.taskId,
      state: 'unknown',
      settled: true,
      error: expect.stringContaining('不会自动重发')
    })])
    expect(result.executionDispatches).toBe(1)
    expect(result.after.state).toBe('completed')
    expect(result.after.attempts).toHaveLength(2)
    expect(result.after.attempts[0]).toMatchObject({ attemptId: settlement.attemptId, state: 'unknown', settled: true })
    expect(result.after.attempts[1]).toMatchObject({ state: 'completed', settled: true })
    expect(result.after.attempts[1]?.attemptId).not.toBe(settlement.attemptId)
  }, 30_000)
})
