import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maskSecrets, type TraceEvent } from '../../shared/trace'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'
import { billingRowsFromItems } from '../billing-ledger'
import { createBuiltInProviderAdapters } from './index'
import { createAntigravityAdapter } from './antigravity'

const FIXTURE = join(process.cwd(), 'src', 'main', 'providers', 'fixtures', 'fake-agy-acp.mjs')
const temps: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

function setupFake(scenario: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-agy-run-'))
  temps.push(dir)
  const home = join(dir, 'home')
  const cwd = join(dir, 'ws')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const bin = join(dir, 'agy')
  const source = readFileSync(FIXTURE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(bin, source, { mode: 0o755 })
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  vi.stubEnv('SCRY_AGY_PATH', bin)
  return { dir, home, cwd, bin, recordPath: join(dir, 'recorded.json') }
}

describe('A4: Antigravity 一轮状态机、事件、审批/提问、用量与费用诚实性', () => {
  it('正常一轮：文本、思考、工具、usage_update 与 separate 用量（thoughtTokens 不重复加、modelStatus=unobserved、费用 null）', async () => {
    const { home, cwd } = setupFake({
      promptSteps: [
        { type: 'thought', text: 'plan step' },
        { type: 'tool_call', data: { toolCallId: 'tc-1', title: 'Read file', kind: 'read', rawInput: { path: 'a.ts' } } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-1', status: 'completed', content: [{ type: 'text', text: 'ok' }] } },
        { type: 'usage_update', used: 1200, size: 1000000 },
        { type: 'text', text: 'done!' }
      ],
      usage: {
        inputTokens: 100,
        cachedReadTokens: 40,
        cachedWriteTokens: 10,
        outputTokens: 50,
        thoughtTokens: 20,
        totalTokens: 200
      }
    })
    const events: TraceEvent[] = []
    const nativeLines: string[] = []
    const adapter = createAntigravityAdapter(home)
    const handle = adapter.run({
      runId: 'run-normal',
      prompt: 'say hi',
      cwd,
      attachments: [],
      permissionMode: 'default',
      emit: (e) => events.push({ ...e, providerId: 'antigravity', runtimeProvider: 'antigravity_acp' }),
      recordNative: (_type, payload) => nativeLines.push(String(payload))
    })
    const result = await handle.promise
    expect(result.status).toBe('completed')
    expect(result.externalSessionId).toBe('sess-fake-1')
    expect(events.some((e) => e.stage === 'thinking' && e.text === 'plan step')).toBe(true)
    expect(events.some((e) => e.stage === 'text_delta' && e.text === 'done!')).toBe(true)
    expect(events.filter((e) => e.stage === 'tool_use')).toHaveLength(1)
    expect(events.filter((e) => e.stage === 'tool_result')).toHaveLength(1)

    const resEvent = events.find((e) => e.stage === 'result')!
    expect(resEvent).toBeDefined()
    expect(resEvent.tokensIn).toBe(100)
    expect(resEvent.tokensOut).toBe(50)
    expect(resEvent.cacheReadTokens).toBe(40)
    expect(resEvent.cacheCreationTokens).toBe(10)
    expect(resEvent.reasoningTokens).toBe(20)
    expect(resEvent.costUsd).toBeUndefined()
    expect(resEvent.contextTokens).toBe(1200)
    expect(
      (resEvent.tokensIn ?? 0) + (resEvent.cacheReadTokens ?? 0) + (resEvent.cacheCreationTokens ?? 0) + (resEvent.tokensOut ?? 0)
    ).toBe(200)
    expect((resEvent.runtimeMetadata as Record<string, unknown>)?.modelStatus).toBe('unobserved')
    expect((resEvent.runtimeMetadata as Record<string, unknown>)?.usageCoverage).toBe('available')

    const ledger = billingRowsFromItems({
      runId: 'run-normal',
      sessionId: 'sess-fake-1',
      cwd,
      items: events,
      nowMs: Date.now(),
      runtimeProvider: 'antigravity_acp'
    })
    expect(ledger.usageLedger).toHaveLength(1)
    // cost column is index 20 in USAGE_LEDGER_COLS — must stay null (never 0) and costUnit='token' without fake sdk_estimate/inferred (S9).
    expect(ledger.usageLedger[0][20]).toBeNull()
    expect(ledger.usageLedger[0][21]).toBeNull()
    expect(ledger.usageLedger[0][22]).toBe('token')
    expect(ledger.usageLedger[0][23]).toBe('provider_reported')
    expect(ledger.usageLedger[0][24]).toBe('provider_reported')
    expect(nativeLines.length).toBeGreaterThan(0)
  })

  it('重复/乱序工具更新、未先见 tool_call 的审批、同 kind 多选项、interaction_ 提问与未知 update', async () => {
    const { home, cwd, recordPath } = setupFake({
      promptSteps: [
        { type: 'unknown_update', name: 'future_event_x', payload: { secret: 'raw-unmasked-AIzaSy12345678901234567890' } },
        {
          type: 'request_permission',
          toolCall: { toolCallId: 'tc-early', title: 'Run shell', kind: 'execute', rawInput: { command: 'ls' } },
          options: [
            { optionId: 'allow_a', name: 'Allow workspace', kind: 'allow_once' },
            { optionId: 'allow_b', name: 'Allow exact command', kind: 'allow_once' },
            { optionId: 'reject_1', name: 'Reject', kind: 'reject_once' }
          ],
          _meta: { 'agy.security.warning': 'Shell execution warning' }
        },
        { type: 'tool_call', data: { toolCallId: 'tc-early', title: 'Run shell', kind: 'execute' } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-early', status: 'in_progress' } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-early', status: 'completed', content: [{ type: 'text', text: 'files' }] } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-early', status: 'completed', content: [{ type: 'text', text: 'files' }] } },
        {
          type: 'request_permission',
          toolCall: { toolCallId: 'interaction_q1', title: 'Which branch?' },
          options: [
            { optionId: 'opt_main', name: 'main', kind: 'allow_once' },
            { optionId: 'opt_dev', name: 'dev', kind: 'allow_once' }
          ]
        },
        { type: 'tool_call', data: { toolCallId: 'sub-1', title: 'Run invoke_subagent', kind: 'other', rawInput: { name: 'invoke_subagent' } } },
        { type: 'tool_call_update', data: { toolCallId: 'sub-1', status: 'completed' } }
      ]
    })
    const events: TraceEvent[] = []
    const nativeLines: string[] = []
    const questions: AgentQuestionRequest[] = []
    const handle = createAntigravityAdapter(home).run({
      runId: 'run-complex',
      prompt: 'complex',
      cwd,
      attachments: [],
      permissionMode: 'full_access',
      emit: (e) => events.push({ ...e, providerId: 'antigravity', runtimeProvider: 'antigravity_acp' }),
      recordNative: (_type, payload) => nativeLines.push(String(payload)),
      requestUserInput: async (req): Promise<AgentQuestionResponse> => {
        questions.push(req)
        const opt = req.questions[0].options[1]
        return {
          runId: req.runId,
          questionId: req.questionId,
          behavior: 'answered',
          answers: { [req.questions[0].question]: opt.answerValue ?? opt.label }
        }
      }
    })
    await handle.promise
    // Both permission (all 3 options kept verbatim!) and interaction_ question (NOT auto-answered in full_access!) reached UI.
    expect(questions).toHaveLength(2)
    expect(questions[0].questionKind).toBe('permission')
    expect(questions[0].questions[0].options).toHaveLength(3)
    expect(questions[0].questions[0].warning).toContain('Shell execution warning')
    expect(questions[1].questionKind).toBe('clarification')

    const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(rec.argv).toEqual(['acp', '--dangerously-skip-permissions'])
    expect(rec.permissionReplies[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_b' } })
    expect(rec.permissionReplies[1].result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt_dev' } })

    // Deduplicated logical tool calls: tc-early emitted once, sub-1 emitted once.
    expect(events.filter((e) => e.stage === 'tool_use' && e.toolUseId === 'tc-early')).toHaveLength(1)
    expect(events.filter((e) => e.stage === 'tool_result' && e.toolUseId === 'tc-early')).toHaveLength(1)
    const resEvent = events.find((e) => e.stage === 'result')!
    expect((resEvent.runtimeMetadata as Record<string, unknown>)?.usageCoverage).toBe('partial')
    expect(nativeLines.join('\n')).toContain('raw-unmasked-AIzaSy12345678901234567890')
  })

  it('权限门禁：拒绝 auto_review，且用户级 settings.json 权限抬高时拒绝启动 (D3)', async () => {
    const { home, cwd } = setupFake()
    const adapter = createAntigravityAdapter(home)
    await expect(adapter.run({
      runId: 'run-bad-mode',
      prompt: 'hi',
      cwd,
      attachments: [],
      permissionMode: 'auto_review',
      emit: () => {}
    }).promise).rejects.toThrow(/unsupportedPermissionMode/i)

    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(
      join(home, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify({ toolPermission: 'auto' })
    )
    await expect(adapter.run({
      runId: 'run-elevated',
      prompt: 'hi',
      cwd,
      attachments: [],
      permissionMode: 'default',
      emit: () => {}
    }).promise).rejects.toThrow(/settings\.json/)
  })

  it('未登录不弹浏览器、不调 OAuth authenticate；显式放行 GEMINI_API_KEY 时调非浏览器 authenticate', async () => {
    const unauth = setupFake({ authMode: 'unauthenticated_32000' })
    const adapter = createAntigravityAdapter(unauth.home)
    await expect(adapter.run({
      runId: 'run-unauth',
      prompt: 'hi',
      cwd: unauth.cwd,
      attachments: [],
      permissionMode: 'default',
      emit: () => {}
    }).promise).rejects.toThrow(/未登录/)
    const recUnauth = JSON.parse(readFileSync(unauth.recordPath, 'utf8'))
    expect(recUnauth.requests.some((r: { method: string }) => r.method === 'authenticate')).toBe(false)

    const apiKey = setupFake({ authMode: 'require_api_key_auth' })
    vi.stubEnv('GEMINI_API_KEY', 'AIzaSyTestApiKeyValue1234567890')
    vi.stubEnv('SCRY_PROVIDER_ENV_ALLOW', 'antigravity:GEMINI_API_KEY')
    const ok = await createAntigravityAdapter(apiKey.home).run({
      runId: 'run-apikey',
      prompt: 'hi',
      cwd: apiKey.cwd,
      attachments: [],
      permissionMode: 'default',
      emit: () => {}
    }).promise
    expect(ok.status).toBe('completed')
    const recKey = JSON.parse(readFileSync(apiKey.recordPath, 'utf8'))
    expect(recKey.requests.find((r: { method: string }) => r.method === 'authenticate')?.params).toEqual({
      methodId: 'gemini-api-key'
    })
  })

  it('resume 优先，失败降级 load 并丢弃重放历史；崩溃 stderr 打码 AIza 与 OAuth URL', async () => {
    const { home, cwd, recordPath } = setupFake({
      failResume: true,
      loadReplay: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD_REPLAY_TEXT' } }
      ],
      promptSteps: [{ type: 'text', text: 'NEW_TURN_TEXT' }]
    })
    const events: TraceEvent[] = []
    await createAntigravityAdapter(home).run({
      runId: 'run-load',
      prompt: 'continue',
      cwd,
      resume: 'sess-prev-1',
      model: { id: 'claude-sonnet-4-5' },
      effort: 'high',
      permissionMode: 'auto_accept_edits',
      attachments: [],
      emit: (e) => events.push({ ...e, providerId: 'antigravity', runtimeProvider: 'antigravity_acp' })
    }).promise
    const text = events.filter((e) => e.stage === 'text_delta').map((e) => e.text).join('')
    expect(text).toBe('NEW_TURN_TEXT')
    expect(text).not.toContain('OLD_REPLAY_TEXT')
    const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(rec.requests.map((r: { method: string }) => r.method)).toEqual(
      expect.arrayContaining(['session/resume', 'session/load', 'session/set_config_option', 'session/set_mode'])
    )

    const crash = setupFake({
      promptSteps: [{
        type: 'crash',
        exitCode: 1,
        stderr: 'fatal key=AIzaSySecretGoogleKey1234567890 url=https://accounts.google.com/o/oauth2?code=MYCODE&state=MYSTATE'
      }]
    })
    let errMsg = ''
    try {
      await createAntigravityAdapter(crash.home).run({
        runId: 'run-crash',
        prompt: 'boom',
        cwd: crash.cwd,
        attachments: [],
        permissionMode: 'default',
        emit: () => {}
      }).promise
    } catch (error) {
      errMsg = error instanceof Error ? error.message : String(error)
    }
    expect(errMsg).not.toContain('AIzaSySecretGoogleKey1234567890')
    expect(errMsg).not.toContain('MYCODE')
    expect(errMsg).not.toContain('MYSTATE')
    expect(maskSecrets('AIzaSySecretGoogleKey1234567890')).toBe('«REDACTED»')
  })

  it('interrupt 先取消未决审批再发 session/cancel；无 usage 标 unavailable；注册表受实验开关控制', async () => {
    const { home, cwd, recordPath } = setupFake({
      usage: null,
      promptSteps: [
        {
          type: 'request_permission',
          toolCall: { toolCallId: 'tc-wait', title: 'Wait forever' },
          options: [{ optionId: 'allow_1', name: 'Allow', kind: 'allow_once' }]
        }
      ]
    })
    const events: TraceEvent[] = []
    let releaseQuestion!: () => void
    const questionAsked = new Promise<void>((resolve) => { releaseQuestion = resolve })
    const handle = createAntigravityAdapter(home).run({
      runId: 'run-cancel',
      prompt: 'stop me',
      cwd,
      attachments: [],
      permissionMode: 'default',
      emit: (e) => events.push({ ...e, providerId: 'antigravity', runtimeProvider: 'antigravity_acp' }),
      requestUserInput: async (_req, signal) => {
        releaseQuestion()
        return await new Promise<AgentQuestionResponse>((resolve) => {
          signal?.addEventListener('abort', () => resolve({ runId: 'run-cancel', questionId: 'q', behavior: 'cancelled' }), { once: true })
        })
      }
    })
    await questionAsked
    handle.interrupt()
    const res = await handle.promise
    expect(res.status).toBe('cancelled')
    const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(rec.permissionReplies[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    const resEvent = events.find((e) => e.stage === 'result')!
    expect((resEvent.runtimeMetadata as Record<string, unknown>)?.usageCoverage).toBe('unavailable')

    vi.stubEnv('SCRY_EXPERIMENTAL_PROVIDERS', '')
    expect(createBuiltInProviderAdapters(home).some((a) => a.id === 'antigravity')).toBe(false)
    vi.stubEnv('SCRY_EXPERIMENTAL_PROVIDERS', 'antigravity')
    expect(createBuiltInProviderAdapters(home).some((a) => a.id === 'antigravity')).toBe(true)
  })
})
