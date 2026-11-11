import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../process-diagnostics'

const env = vi.hoisted(() => ({ runtimeCliEnv: vi.fn((_base?: unknown, _options?: unknown) => ({}) as Record<string, string>) }))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: vi.fn(),
  startDaemon: vi.fn()
}))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/opt/qoder/qodercli.js',
  runtimeCliEnv: env.runtimeCliEnv,
  shellEnv: () => ({})
}))

import { pickDaemonChild, qoderDaemonEnv, startQoderDaemon, type QoderDaemonStarter } from './qoder-daemon'

const EXE = '/opt/qoder/qodercli.js'

function row(pid: number, command: string): ProcessRow {
  return { pid, ppid: process.pid, status: 'S', startedAt: `Mon Nov 10 10:00:${String(pid % 60).padStart(2, '0')} 2026`, command }
}

function fakeDaemon() {
  return { onFailure: vi.fn(() => () => {}), stop: vi.fn().mockResolvedValue(undefined) }
}

describe('pickDaemonChild', () => {
  it('takes the one new child started with this executable and --sdk', () => {
    const daemon = row(20, `node ${EXE} --sdk`)
    expect(pickDaemonChild(new Set([10]), [row(10, `node ${EXE} --sdk`), daemon], EXE)).toBe(daemon)
  })

  it.each([
    ['no new child', [row(10, `node ${EXE} --sdk`)]],
    ['two candidates', [row(20, `node ${EXE} --sdk`), row(21, `node ${EXE} --sdk`)]],
    ['another executable', [row(20, 'node /elsewhere/qodercli.js --sdk')]],
    ['a version probe', [row(20, `node ${EXE} --version`)]]
  ])('leaves the pid unknown with %s', (_case, after) => {
    expect(pickDaemonChild(new Set([10]), after, EXE)).toBeUndefined()
  })
})

describe('qoderDaemonEnv', () => {
  beforeEach(() => env.runtimeCliEnv.mockReset().mockReturnValue({}))

  it('injects the managed identity only for a managed run and drops stale values', () => {
    env.runtimeCliEnv.mockReturnValue({ SCRY_RECORDER_MANAGED: '1', SCRY_MANAGED_RUN_ID: 'stale', SCRY_MANAGED_PROMPT_HASH: 'stale' })
    expect(qoderDaemonEnv({ managedRecorder: true, managedIdentity: { runId: 'run-1', promptHash: 'a'.repeat(64) } })).toMatchObject({
      SCRY_RECORDER_MANAGED: '1', SCRY_MANAGED_RUN_ID: 'run-1', SCRY_MANAGED_PROMPT_HASH: 'a'.repeat(64),
      QODERCLI_PRINT_BG_WAIT_CEILING_MS: '0'
    })
    const plain = qoderDaemonEnv({})
    expect(plain).not.toHaveProperty('SCRY_MANAGED_RUN_ID')
    expect(plain).not.toHaveProperty('SCRY_MANAGED_PROMPT_HASH')
    expect(env.runtimeCliEnv).toHaveBeenLastCalledWith(undefined, { providerId: 'qoder' })
  })
})

describe('startQoderDaemon', () => {
  it('starts a process-carrier daemon with this run\'s env and records its child identity', async () => {
    const daemon = fakeDaemon()
    const listings: ProcessRow[][] = [[row(10, 'other')], [row(10, 'other'), row(30, `node ${EXE} --sdk`)]]
    const starter: QoderDaemonStarter = {
      start: vi.fn(async () => daemon) as never,
      children: async () => listings.shift() ?? []
    }
    const lease = await startQoderDaemon({ managedRecorder: true, managedIdentity: { runId: 'run-1', promptHash: 'b'.repeat(64) } }, starter)
    expect(starter.start).toHaveBeenCalledWith(expect.objectContaining({
      auth: { type: 'qodercli' }, pathToQoderCLIExecutable: EXE, launchMode: 'process',
      env: expect.objectContaining({ SCRY_MANAGED_RUN_ID: 'run-1' })
    }))
    expect(lease).toMatchObject({ pid: 30, identity: { pid: 30, command: `node ${EXE} --sdk` } })
    expect(lease.identity?.startedAt).toBeTruthy()
    await Promise.all([lease.stop(), lease.stop()])
    expect(daemon.stop).toHaveBeenCalledOnce()
  })

  it('serializes starts so each new child is attributable to one lease', async () => {
    let live: ProcessRow[] = []
    let inFlight = 0
    let overlapped = false
    let next = 40
    const starter: QoderDaemonStarter = {
      start: vi.fn(async () => {
        inFlight += 1
        overlapped ||= inFlight > 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        live = [...live, row(next++, `node ${EXE} --sdk`)]
        inFlight -= 1
        return fakeDaemon()
      }) as never,
      children: async () => live
    }
    const [a, b] = await Promise.all([startQoderDaemon({}, starter), startQoderDaemon({}, starter)])
    expect(overlapped).toBe(false)
    expect(new Set([a.pid, b.pid])).toEqual(new Set([40, 41]))
  })

  it('reports the CLI\'s own stderr when the daemon cannot start, and later starts still run', async () => {
    const failing: QoderDaemonStarter = {
      start: vi.fn(async (options: { stderr?: (data: string) => void }) => {
        options.stderr?.('sdk_worker_removed: roll back the CLI\n')
        throw new Error('Daemon connection closed')
      }) as never,
      children: async () => []
    }
    await expect(startQoderDaemon({}, failing)).rejects.toThrow(/守护进程启动失败：Daemon connection closed\nsdk_worker_removed/)
    const lease = await startQoderDaemon({}, { start: vi.fn(async () => fakeDaemon()) as never, children: async () => { throw new Error('ps missing') } })
    // ps unavailable: the daemon runs, but its pid stays unknown rather than guessed.
    expect(lease.pid).toBeUndefined()
    expect(lease.identity).toBeUndefined()
  })
})

describe('daemon ownership invariant', () => {
  it('only qoder-daemon.ts calls the SDK query/startDaemon, so nothing reaches the shared daemon', () => {
    const dir = __dirname
    const offenders = readdirSync(dir)
      .filter((name) => name.startsWith('qoder') && name.endsWith('.ts') && !name.includes('.test.') && name !== 'qoder-daemon.ts')
      .filter((name) => {
        const source = readFileSync(join(dir, name), 'utf8')
        const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@qoder-ai\/qoder-agent-sdk'/g)]
        return imports.some((match) => !match[1] && match[2].split(',').some((part) => /^\s*(query|startDaemon|acquireGlobalDaemon|initDaemon)\s*$/.test(part)))
      })
    expect(offenders).toEqual([])
  })
})
