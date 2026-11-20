import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { providerMcpConfigPaths } from '../mcp-config'
import { createAntigravityAdapter } from './antigravity'

const FAKE_FIXTURE_SOURCE = join(process.cwd(), 'src/main/providers/fixtures/fake-agy-acp.mjs')
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function installFakeAgy(scenario: Record<string, unknown>) {
  const dir = makeTempDir('scry-agy-b1b2-')
  const binPath = join(dir, 'fake-agy')
  const source = readFileSync(FAKE_FIXTURE_SOURCE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(binPath, source, { mode: 0o755 })
  chmodSync(binPath, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario), 'utf8')
  return { dir, binPath, recordPath: join(dir, 'recorded.json') }
}

const savedEnv = {
  SCRY_AGY_PATH: process.env.SCRY_AGY_PATH,
  GEMINI_HOME: process.env.GEMINI_HOME,
  SCRY_PROVIDER_ENV_ALLOW: process.env.SCRY_PROVIDER_ENV_ALLOW
}

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('W8 复核 B1：所有 .gemini 根目录推导统一使用清洗后的启动环境', () => {
  it('未放行 GEMINI_HOME 时，GEMINI_HOME 指向空目录不能绕过真实 ~/.gemini 的 toolPermission:auto，且 MCP/Skill/continuationKey 一致', async () => {
    const fakeHome = makeTempDir('scry-home-b1-')
    const fakeEmptyGemini = makeTempDir('scry-empty-gemini-')
    const ws = makeTempDir('scry-ws-b1-')
    const userData = makeTempDir('scry-ud-b1-')

    // 真实 homeDir/.gemini 下存在 toolPermission: auto、user MCP、user Skill
    mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(join(fakeHome, '.gemini', 'config', 'skills', 'real-skill'), { recursive: true })
    writeFileSync(
      join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify({ toolPermission: 'auto' }),
      'utf8'
    )
    writeFileSync(
      join(fakeHome, '.gemini', 'config', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { realUserMcp: { command: 'echo', args: ['hi'] } } }),
      'utf8'
    )
    writeFileSync(
      join(fakeHome, '.gemini', 'config', 'skills', 'real-skill', 'SKILL.md'),
      '---\nname: real-skill\ndescription: from real home\n---\n',
      'utf8'
    )

    // 空目录 GEMINI_HOME 下放一个诱饵 skill 与诱饵 MCP，且无 settings.json
    mkdirSync(join(fakeEmptyGemini, 'config', 'skills', 'decoy-skill'), { recursive: true })
    writeFileSync(
      join(fakeEmptyGemini, 'config', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { decoyMcp: { command: 'echo', args: ['decoy'] } } }),
      'utf8'
    )
    writeFileSync(
      join(fakeEmptyGemini, 'config', 'skills', 'decoy-skill', 'SKILL.md'),
      '---\nname: decoy-skill\ndescription: from decoy\n---\n',
      'utf8'
    )

    const { binPath } = installFakeAgy({ reply: 'should-not-run' })
    process.env.SCRY_AGY_PATH = binPath
    process.env.GEMINI_HOME = fakeEmptyGemini
    delete process.env.SCRY_PROVIDER_ENV_ALLOW

    const adapter = createAntigravityAdapter(fakeHome, { userDataDir: userData })

    // 1. default 运行必须被真实 homeDir/.gemini 的 toolPermission:auto 拒绝（不能被未放行的 GEMINI_HOME 绕过）
    await expect(
      adapter.run({
        runId: 'b1-bypass-check',
        prompt: 'hi',
        cwd: ws,
        attachments: [],
        permissionMode: 'default',
        emit: () => undefined
      }).promise
    ).rejects.toThrow(/已拒绝启动 Antigravity/)

    // 2. MCP 路径、MCP 快照、Skill 列表必须全部读真实 homeDir/.gemini，而不是未放行的 GEMINI_HOME
    const mcpPaths = providerMcpConfigPaths('antigravity', ws, fakeHome, process.env)
    expect(mcpPaths).toContain(join(fakeHome, '.gemini', 'config', 'mcp_config.json'))
    expect(mcpPaths).not.toContain(join(fakeEmptyGemini, 'config', 'mcp_config.json'))

    const mcpSnap = await adapter.mcp!.snapshot({ providerId: 'antigravity', cwd: ws })
    expect(mcpSnap.data?.configured.map((m) => m.name)).toContain('realUserMcp')
    expect(mcpSnap.data?.configured.map((m) => m.name)).not.toContain('decoyMcp')

    const skills = await adapter.skills!.list({ providerId: 'antigravity', cwd: ws })
    expect(skills.data?.map((s) => s.name)).toContain('real-skill')
    expect(skills.data?.map((s) => s.name)).not.toContain('decoy-skill')

    const keyWithoutAllow = await adapter.continuationKey!({ providerId: 'antigravity', cwd: ws })

    // 3. 显式放行 SCRY_PROVIDER_ENV_ALLOW=antigravity:GEMINI_HOME 后，全部 5 处一致切换到 fakeEmptyGemini
    process.env.SCRY_PROVIDER_ENV_ALLOW = 'antigravity:GEMINI_HOME'
    const mcpPathsAllowed = providerMcpConfigPaths('antigravity', ws, fakeHome, process.env)
    expect(mcpPathsAllowed).toContain(join(fakeEmptyGemini, 'config', 'mcp_config.json'))
    const mcpSnapAllowed = await adapter.mcp!.snapshot({ providerId: 'antigravity', cwd: ws })
    expect(mcpSnapAllowed.data?.configured.map((m) => m.name)).toContain('decoyMcp')
    const skillsAllowed = await adapter.skills!.list({ providerId: 'antigravity', cwd: ws })
    expect(skillsAllowed.data?.map((s) => s.name)).toContain('decoy-skill')
    const keyWithAllow = await adapter.continuationKey!({ providerId: 'antigravity', cwd: ws })
    expect(keyWithAllow).not.toBe(keyWithoutAllow)
  }, 15_000)
})

describe('W8 复核 B2：运行并发、排队停止与槽位后置门禁', () => {
  it('两个不同工作区的运行可并发执行，不被目录探测互斥锁串行化', async () => {
    const fakeHome = makeTempDir('scry-home-b2-')
    const ws1 = makeTempDir('scry-ws-b2-1-')
    const ws2 = makeTempDir('scry-ws-b2-2-')
    const { binPath } = installFakeAgy({
      promptSteps: [
        { type: 'text', text: 'started' },
        { type: 'sleep', ms: 600 },
        { type: 'text', text: 'done' }
      ]
    })
    process.env.SCRY_AGY_PATH = binPath

    const adapter = createAntigravityAdapter(fakeHome)
    let r1FirstAt = 0
    let r2FirstAt = 0
    let r1DoneAt = 0
    let r2DoneAt = 0
    const p1 = adapter.run({
      runId: 'conc-1',
      prompt: 'one',
      cwd: ws1,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => { if (!r1FirstAt && ev.stage === 'text_delta') r1FirstAt = Date.now() }
    }).promise.then((res) => { r1DoneAt = Date.now(); return res })
    const p2 = adapter.run({
      runId: 'conc-2',
      prompt: 'two',
      cwd: ws2,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => { if (!r2FirstAt && ev.stage === 'text_delta') r2FirstAt = Date.now() }
    }).promise.then((res) => { r2DoneAt = Date.now(); return res })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('completed')
    expect(r2.status).toBe('completed')
    // 真正重叠并发：两者都在对方结束前已经产出首个事件（串行化时必有一方在另一方结束后才开始）
    expect(r1FirstAt).toBeGreaterThan(0)
    expect(r2FirstAt).toBeGreaterThan(0)
    expect(r2FirstAt).toBeLessThan(r1DoneAt)
    expect(r1FirstAt).toBeLessThan(r2DoneAt)
  }, 15_000)

  it('排队等待槽位中的运行可立刻停止，且不触发门禁、不准备 MCP、不启动 agy', async () => {
    const fakeHome = makeTempDir('scry-home-b2-q-')
    const ws = makeTempDir('scry-ws-b2-q-')
    const { binPath } = installFakeAgy({ reply: 'never', sessionNewDelayMs: 1200 })
    process.env.SCRY_AGY_PATH = binPath

    let trustChecks = 0
    let mcpPrepares = 0
    const adapter = createAntigravityAdapter(fakeHome, {
      checkWorkspaceTrust: () => { trustChecks += 1 },
      prepareMcp: async () => { mcpPrepares += 1; return { mcpServers: [] } }
    })

    // 先触发目录探测占住独占探测槽位
    const catalogPromise = adapter.runControls!.read({ providerId: 'antigravity', cwd: ws })
    await new Promise((r) => setTimeout(r, 50))

    const events: TraceEvent[] = []
    const queuedHandle = adapter.run({
      runId: 'queued-cancel',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => events.push(ev)
    })

    // 排队期间不该提前跑门禁与 MCP 准备
    await new Promise((r) => setTimeout(r, 30))
    expect(trustChecks).toBe(0)
    expect(mcpPrepares).toBe(0)

    const cancelStart = Date.now()
    queuedHandle.interrupt()
    const result = await queuedHandle.promise
    expect(Date.now() - cancelStart).toBeLessThan(500)
    expect(result.status).toBe('cancelled')
    expect(result.stopped).toBe(true)
    expect(trustChecks).toBe(0)
    expect(mcpPrepares).toBe(0)

    await catalogPromise
  }, 15_000)
})

describe('W8 维护者决定 D11 / D12 与应修 S8：用户规则、有效权限与 hook 放行', () => {
  it('用户级具体命令 permissions.allow 在 default 与 auto_accept_edits 下照常启动并记录规则；full_access 有效权限不降级（S8）', async () => {
    const fakeHome = makeTempDir('scry-home-d11-')
    const ws = makeTempDir('scry-ws-d11-')
    mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(
      join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['command(git fetch)', 'command(ls)'] } }),
      'utf8'
    )
    const { binPath } = installFakeAgy({ reply: 'd11-ok' })
    process.env.SCRY_AGY_PATH = binPath
    const adapter = createAntigravityAdapter(fakeHome)

    const defaultEvents: TraceEvent[] = []
    const rDefault = await adapter.run({
      runId: 'd11-default',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => defaultEvents.push(ev)
    }).promise
    expect(rDefault.status).toBe('completed')
    const defaultResult = defaultEvents.find((e) => e.kind === 'harness' && e.stage === 'result')
    expect(defaultResult?.runtimeMetadata?.effectivePermissionMode).toBe('default + 用户规则')
    expect(defaultResult?.runtimeMetadata?.userAllowRules).toEqual(['command(git fetch)', 'command(ls)'])
    expect(String(defaultResult?.runtimeMetadata?.userAllowNotice)).toContain('agy 用户级规则会自动放行')

    const fullEvents: TraceEvent[] = []
    const rFull = await adapter.run({
      runId: 'd11-full',
      prompt: 'hi',
      cwd: ws,
      attachments: [],
      permissionMode: 'full_access',
      emit: (ev) => fullEvents.push(ev)
    }).promise
    expect(rFull.status).toBe('completed')
    const fullResult = fullEvents.find((e) => e.kind === 'harness' && e.stage === 'result')
    // S8：不能降级记为 permissions.allow
    expect(String(fullResult?.runtimeMetadata?.effectivePermissionMode)).toMatch(/^full_access/)
  }, 15_000)

  it('工作区或用户级 PreToolUse hooks.json 不拒绝启动，且未经审批执行的工具调用标为「由 hook 放行」', async () => {
    const fakeHome = makeTempDir('scry-home-d12-')
    const ws = makeTempDir('scry-ws-d12-')
    mkdirSync(join(ws, '.agents'), { recursive: true })
    writeFileSync(
      join(ws, '.agents', 'hooks.json'),
      JSON.stringify({
        'disabled-gate': { enabled: false, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo {}' }] }] },
        'allow-cmd': { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo allow' }] }] }
      }),
      'utf8'
    )
    const { binPath } = installFakeAgy({
      promptSteps: [
        { type: 'tool_call', data: { toolCallId: 'tc-hook-1', title: 'Run run_command', kind: 'execute', rawInput: { command: 'echo hi' } } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-hook-1', status: 'completed', content: 'hi' } },
        { type: 'text', text: 'hook-allowed-ok' }
      ]
    })
    process.env.SCRY_AGY_PATH = binPath
    const adapter = createAntigravityAdapter(fakeHome)

    const events: TraceEvent[] = []
    const res = await adapter.run({
      runId: 'd12-hook',
      prompt: 'run cmd',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => events.push(ev)
    }).promise
    expect(res.status).toBe('completed')
    const toolResult = events.find((e) => e.kind === 'tool' && e.stage === 'tool_result' && e.toolUseId === 'tc-hook-1')
    expect(toolResult?.runtimeMetadata?.approvalSource).toBe('hook')
    expect(toolResult?.runtimeMetadata?.approvalLabel).toBe('由 hook 放行')
  }, 15_000)
})
