import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { isIntervention } from '../../shared/turn-intervention-validation'
import { RunStopLifecycle } from '../run-stop-lifecycle'
import { buildAntigravityQuestionRequest } from './antigravity-permissions'
import { runAntigravity } from './antigravity-run'

const FAKE_FIXTURE_SOURCE = join(process.cwd(), 'src/main/providers/fixtures/fake-agy-acp.mjs')
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function installFakeAgy(scenario: Record<string, unknown>) {
  const dir = makeTempDir('scry-agy-edge-')
  const binPath = join(dir, 'fake-agy')
  const source = readFileSync(FAKE_FIXTURE_SOURCE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(binPath, source, { mode: 0o755 })
  chmodSync(binPath, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario), 'utf8')
  return { dir, binPath, recordPath: join(dir, 'recorded.json') }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const savedEnv = {
  SCRY_AGY_PATH: process.env.SCRY_AGY_PATH,
  SCRY_PROVIDER_ENV_ALLOW: process.env.SCRY_PROVIDER_ENV_ALLOW,
  AGY_ADC_AUTH: process.env.AGY_ADC_AUTH,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT
}

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('W8 复核 S2 / S6 / S7：边界场景、完整选项保留、独立后代强杀与 RunStopLifecycle 升级', () => {
  it('S2: 审批选项超过 4 个时原样保留全部选项，不截断且通过 intervention 校验', () => {
    const options = Array.from({ length: 6 }, (_, i) => ({
      optionId: `opt_${i + 1}`,
      name: `允许范围 #${i + 1}`,
      kind: 'allow_once'
    }))
    const { request } = buildAntigravityQuestionRequest({
      runId: 'run-s2',
      questionId: 'q-s2',
      params: { toolCall: { toolCallId: 'tc-s2', title: 'Run command' }, options }
    })
    expect(request.questions[0].options).toHaveLength(6)
    expect(request.questions[0].options.map((o) => o.answerValue)).toEqual(options.map((o) => o.optionId))
    const intervention = {
      kind: 'permission',
      source: request.source,
      resolution: 'answered',
      openedAt: '2026-11-20T00:00:00.000Z',
      closedAt: '2026-11-20T00:00:01.000Z',
      durationMs: 1000,
      request,
      response: {
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'answered',
        answers: { [request.questions[0].question]: 'opt_6' }
      }
    }
    expect(isIntervention(intervention)).toBe(true)
  })

  it('S7-1: 发出 cancel 后仍收到 end_turn 时按实际结果收口并记 cancelRequestedBeforeEndTurn，保留已有输出', async () => {
    const fakeHome = makeTempDir('scry-home-s7-')
    const ws = makeTempDir('scry-ws-s7-')
    const { binPath } = installFakeAgy({
      endTurnAfterCancel: true,
      promptSteps: [
        { type: 'text', text: 'partial-before-cancel' },
        { type: 'sleep', ms: 400 }
      ]
    })
    process.env.SCRY_AGY_PATH = binPath
    const events: TraceEvent[] = []
    const handle = runAntigravity({
      runId: 's7-end-after-cancel',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => {
        events.push(ev)
        if (ev.stage === 'text_delta') handle.interrupt()
      }
    }, { homeDir: fakeHome })
    const res = await handle.promise
    expect(res.status).toBe('completed')
    expect(events.some((e) => e.stage === 'text_delta' && e.text === 'partial-before-cancel')).toBe(true)
    const resultEv = events.find((e) => e.kind === 'harness' && e.stage === 'result')
    expect(resultEv?.runtimeMetadata?.cancelRequestedBeforeEndTurn).toBe(true)
  }, 15_000)

  it('S7-2: 发出 cancel 后收到 JSON-RPC 错误按 cancelled 收口并保留原始错误码', async () => {
    const fakeHome = makeTempDir('scry-home-s7-2-')
    const ws = makeTempDir('scry-ws-s7-2-')
    const { binPath } = installFakeAgy({
      promptError: { code: -32800, message: 'Request cancelled by peer' },
      promptSteps: [{ type: 'text', text: 'start' }, { type: 'sleep', ms: 400 }]
    })
    process.env.SCRY_AGY_PATH = binPath
    const events: TraceEvent[] = []
    const handle = runAntigravity({
      runId: 's7-cancel-rpc-err',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => {
        events.push(ev)
        if (ev.stage === 'text_delta') handle.interrupt()
      }
    }, { homeDir: fakeHome })
    const res = await handle.promise
    expect(res.status).toBe('cancelled')
    const resultEv = events.find((e) => e.kind === 'harness' && e.stage === 'result')
    expect(resultEv?.runtimeMetadata?.stopReason).toBe('cancelled_rpc_-32800')
  }, 15_000)

  it('S7-3: 尚无 sessionId（卡在 initialize）时 interrupt 直接按身份发 SIGTERM', async () => {
    const fakeHome = makeTempDir('scry-home-s7-3-')
    const ws = makeTempDir('scry-ws-s7-3-')
    const { binPath } = installFakeAgy({ hangOnInitialize: true })
    process.env.SCRY_AGY_PATH = binPath
    const handle = runAntigravity({
      runId: 's7-hang-init',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: () => undefined
    }, { homeDir: fakeHome })
    setTimeout(() => handle.interrupt(), 250)
    await expect(handle.promise).rejects.toThrow()
    expect(handle.getExternalSessionId()).toBeUndefined()
  }, 15_000)

  it('S7-4 & S7-5: -32603 No browser 与运行中出现登录提示行均判未登录且不泄露 OAuth state', async () => {
    const fakeHome = makeTempDir('scry-home-s7-4-')
    const ws = makeTempDir('scry-ws-s7-4-')

    const noBrowser = installFakeAgy({ authMode: 'no_browser_32603' })
    process.env.SCRY_AGY_PATH = noBrowser.binPath
    await expect(runAntigravity({
      runId: 's7-no-browser', prompt: 'hi', cwd: ws, attachments: [], permissionMode: 'default', emit: () => undefined
    }, { homeDir: fakeHome }).promise).rejects.toThrow(/Antigravity 未登录/)

    const midLogin = installFakeAgy({ authMode: 'login_prompt_line' })
    process.env.SCRY_AGY_PATH = midLogin.binPath
    const nativeLines: unknown[] = []
    await expect(runAntigravity({
      runId: 's7-login-line', prompt: 'hi', cwd: ws, attachments: [], permissionMode: 'default',
      emit: () => undefined,
      recordNative: (_t, p) => nativeLines.push(p)
    }, { homeDir: fakeHome }).promise).rejects.toThrow(/Antigravity 未登录/)
    expect(JSON.stringify(nativeLines)).not.toContain('SECRET_OAUTH_STATE_12345')
  }, 15_000)

  it('S7-6: 显式放行 AGY_ADC_AUTH + GOOGLE_CLOUD_PROJECT 时调用非浏览器 authenticate(agent-platform)', async () => {
    const fakeHome = makeTempDir('scry-home-s7-6-')
    const ws = makeTempDir('scry-ws-s7-6-')
    const { binPath, recordPath } = installFakeAgy({ authMode: 'require_adc_auth' })
    process.env.SCRY_AGY_PATH = binPath
    process.env.AGY_ADC_AUTH = '1'
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-gcp-proj'
    process.env.SCRY_PROVIDER_ENV_ALLOW = 'antigravity:AGY_ADC_AUTH,antigravity:GOOGLE_CLOUD_PROJECT'
    const res = await runAntigravity({
      runId: 's7-adc', prompt: 'hi', cwd: ws, attachments: [], permissionMode: 'default', emit: () => undefined
    }, { homeDir: fakeHome }).promise
    expect(res.status).toBe('completed')
    const rec = JSON.parse(readFileSync(recordPath, 'utf8')) as { requests: Array<{ method: string; params?: { methodId?: string } }> }
    expect(rec.requests.some((r) => r.method === 'authenticate' && r.params?.methodId === 'agent-platform')).toBe(true)
  }, 15_000)

  it('S7-7 & S7-8: PromptResponse 后尾随更新不崩不双发 result，关 stdin 后自然退出', async () => {
    const fakeHome = makeTempDir('scry-home-s7-8-')
    const ws = makeTempDir('scry-ws-s7-8-')
    const { binPath } = installFakeAgy({
      trailingUpdatesAfterResult: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late-trailing' } }
      ]
    })
    process.env.SCRY_AGY_PATH = binPath
    const events: TraceEvent[] = []
    const res = await runAntigravity({
      runId: 's7-trailing', prompt: 'hi', cwd: ws, attachments: [], permissionMode: 'default',
      emit: (ev) => events.push(ev)
    }, { homeDir: fakeHome }).promise
    expect(res.status).toBe('completed')
    expect(events.filter((e) => e.kind === 'harness' && e.stage === 'result')).toHaveLength(1)
  }, 15_000)

  it('S6 & S7-9: RunStopLifecycle 驱动 antigravity_acp 从 interrupt 升级 forceKill，即使根进程忽略 SIGTERM 也清理独立 PGID 后代', async () => {
    const fakeHome = makeTempDir('scry-home-s7-9-')
    const ws = makeTempDir('scry-ws-s7-9-')
    const { binPath, recordPath } = installFakeAgy({
      ignoreCancel: true,
      promptSteps: [
        { type: 'spawn_detached_child', ms: 30_000 },
        { type: 'text', text: 'spawned' },
        { type: 'sleep', ms: 10_000 }
      ]
    })
    process.env.SCRY_AGY_PATH = binPath

    const phases: string[] = []
    const lifecycle = new RunStopLifecycle({
      publish: (state) => { phases.push(state.phase) },
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, Math.min(ms, 150))
        return () => clearTimeout(timer)
      }
    })

    const handle = runAntigravity({
      runId: 's7-lifecycle',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => {
        if (ev.stage === 'text_delta') {
          lifecycle.request({
            runId: 's7-lifecycle',
            providerId: 'antigravity',
            runtimeProvider: 'antigravity_acp',
            interrupt: handle.interrupt,
            forceKill: handle.forceKill,
            forceKillScope: () => handle.forceKillScope
          })
        }
      }
    }, { homeDir: fakeHome })

    await handle.promise.catch(() => undefined)
    lifecycle.settle('s7-lifecycle')
    await new Promise((r) => setTimeout(r, 300))

    expect(phases).toContain('interrupt_requested')
    expect(phases).toContain('force_kill_requested')
    const rec = JSON.parse(readFileSync(recordPath, 'utf8')) as { spawnedChildPids: number[] }
    expect(rec.spawnedChildPids.length).toBeGreaterThan(0)
    for (const pid of rec.spawnedChildPids) {
      expect(isPidAlive(pid)).toBe(false)
    }
  }, 15_000)
})
