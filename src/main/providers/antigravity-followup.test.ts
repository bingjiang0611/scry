import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import * as locate from '../claude-locate'
import { createAntigravityAdapter } from './antigravity'
import { AntigravityEventTranslator } from './antigravity-events'
import { buildAntigravityLaunchEnv } from './antigravity-launch'
import {
  antigravityEffectiveGeminiRoot,
  antigravityGeminiRoot,
  collectAllowCapablePreToolUseMatchers
} from './antigravity-mcp-paths'

const FAKE_FIXTURE_SOURCE = join(process.cwd(), 'src/main/providers/fixtures/fake-agy-acp.mjs')
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function installFakeAgy(scenario: Record<string, unknown>) {
  const dir = makeTempDir('scry-agy-followup-')
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

beforeEach(() => {
  vi.spyOn(locate, 'shellEnv').mockReturnValue({ PATH: process.env.PATH ?? '/usr/bin:/bin' })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('W8 第三轮后续项 1：run 内选择 allow_always 后停止推断「由 hook 放行」', () => {
  it('选择 allow_always 后，后续未经审批执行的工具不再被推断为「由 hook 放行」（显式 _meta 仍保留）；选 allow_once 时仍正常推断', async () => {
    const fakeHome = makeTempDir('scry-home-aa-')
    const ws = makeTempDir('scry-ws-aa-')
    mkdirSync(join(ws, '.agents'), { recursive: true })
    writeFileSync(
      join(ws, '.agents', 'hooks.json'),
      JSON.stringify({
        'allow-cmd': {
          PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'printf \'{"decision":"allow"}\\n\'' }] }]
        }
      }),
      'utf8'
    )

    const { binPath } = installFakeAgy({
      promptSteps: [
        { type: 'tool_call', data: { toolCallId: 'tc-1', title: 'Run run_command', kind: 'execute', rawInput: { command: 'echo 1' } } },
        {
          type: 'request_permission',
          toolCall: { toolCallId: 'tc-1', title: 'Run run_command', kind: 'execute', rawInput: { command: 'echo 1' } },
          options: [
            { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'opt-always-cmd', name: 'Always allow this command', kind: 'allow_always' }
          ]
        },
        { type: 'tool_call_update', data: { toolCallId: 'tc-1', status: 'completed', content: '1' } },
        // tc-2 runs without request_permission: after allow_always, Scry cannot tell whether allow_always or hook allowed it.
        { type: 'tool_call', data: { toolCallId: 'tc-2', title: 'Run run_command', kind: 'execute', rawInput: { command: 'echo 2' } } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-2', status: 'completed', content: '2' } },
        // tc-3 carries explicit ACP _meta evidence from agy, so exact hook label is still emitted.
        { type: 'tool_call', data: { toolCallId: 'tc-3', title: 'Run run_command', kind: 'execute', rawInput: { command: 'echo 3' } } },
        { type: 'tool_call_update', data: { toolCallId: 'tc-3', status: 'completed', content: '3', _meta: { 'agy.hook.decision': 'allow' } } },
        { type: 'text', text: 'done' }
      ]
    })
    process.env.SCRY_AGY_PATH = binPath
    const adapter = createAntigravityAdapter(fakeHome)

    const eventsAlways: TraceEvent[] = []
    const resAlways = await adapter.run({
      runId: 'followup-allow-always',
      prompt: 'run',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => eventsAlways.push(ev),
      requestUserInput: async (req) => ({
        runId: req.runId,
        questionId: req.questionId,
        behavior: 'answered',
        answers: { [req.questions[0].question]: 'opt-always-cmd' }
      })
    }).promise
    expect(resAlways.status).toBe('completed')
    const tc1Always = eventsAlways.find((e) => e.kind === 'tool' && e.stage === 'tool_result' && e.toolUseId === 'tc-1')
    const tc2Always = eventsAlways.find((e) => e.kind === 'tool' && e.stage === 'tool_result' && e.toolUseId === 'tc-2')
    const tc3Always = eventsAlways.find((e) => e.kind === 'tool' && e.stage === 'tool_result' && e.toolUseId === 'tc-3')
    expect(tc1Always?.runtimeMetadata?.approvalSource).toBeUndefined()
    expect(tc2Always?.runtimeMetadata?.approvalSource).toBeUndefined()
    expect(tc3Always?.runtimeMetadata?.approvalSource).toBe('hook')

    // 2. 对照：选 allow_once 时，tc-2 未经审批且匹配可放行 hook，仍按规则推断为「由 hook 放行」
    const eventsOnce: TraceEvent[] = []
    const resOnce = await adapter.run({
      runId: 'followup-allow-once',
      prompt: 'run',
      cwd: ws,
      attachments: [],
      permissionMode: 'default',
      emit: (ev) => eventsOnce.push(ev),
      requestUserInput: async (req) => ({
        runId: req.runId,
        questionId: req.questionId,
        behavior: 'answered',
        answers: { [req.questions[0].question]: 'opt-once' }
      })
    }).promise
    expect(resOnce.status).toBe('completed')
    const tc2Once = eventsOnce.find((e) => e.kind === 'tool' && e.stage === 'tool_result' && e.toolUseId === 'tc-2')
    expect(tc2Once?.runtimeMetadata?.approvalSource).toBe('hook')
    expect(tc2Once?.runtimeMetadata?.approvalLabel).toBe('由 hook 放行')
  }, 15_000)
})

describe('W8 第三轮后续项 2：hook 脚本 realpath 边界限制与防回溯爆炸 matcher', () => {
  it('拒绝读取 scanRoots/.gemini 之外的脚本（绝对路径、../ 穿越、父目录符号链接），允许边界内真实脚本', () => {
    const fakeHome = makeTempDir('scry-home-hook-bound-')
    const outsideDir = makeTempDir('scry-outside-hook-')
    const outsideScript = join(outsideDir, 'outside-allow.sh')
    writeFileSync(outsideScript, '#!/bin/sh\nprintf \'{"decision":"allow"}\\n\'\n', 'utf8')

    const wsAbs = makeTempDir('scry-ws-hook-abs-')
    mkdirSync(join(wsAbs, '.agents'), { recursive: true })
    writeFileSync(
      join(wsAbs, '.agents', 'hooks.json'),
      JSON.stringify({ ext: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: `sh ${outsideScript}` }] }] } }),
      'utf8'
    )
    expect(collectAllowCapablePreToolUseMatchers(wsAbs, fakeHome)).toEqual([])

    const wsRel = makeTempDir('scry-ws-hook-rel-')
    mkdirSync(join(wsRel, '.agents'), { recursive: true })
    const relEscape = relative(join(wsRel, '.agents'), outsideScript)
    writeFileSync(
      join(wsRel, '.agents', 'hooks.json'),
      JSON.stringify({ rel: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: `sh ${relEscape}` }] }] } }),
      'utf8'
    )
    expect(collectAllowCapablePreToolUseMatchers(wsRel, fakeHome)).toEqual([])

    // C. 父目录是符号链接（.agents/scripts -> outsideDir），目标文件本身是普通文件 -> 必须经 realpath 拦截
    const wsSymlinkParent = makeTempDir('scry-ws-hook-symdir-')
    mkdirSync(join(wsSymlinkParent, '.agents'), { recursive: true })
    symlinkSync(outsideDir, join(wsSymlinkParent, '.agents', 'scripts'))
    writeFileSync(
      join(wsSymlinkParent, '.agents', 'hooks.json'),
      JSON.stringify({
        sym: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'sh scripts/outside-allow.sh' }] }] }
      }),
      'utf8'
    )
    expect(collectAllowCapablePreToolUseMatchers(wsSymlinkParent, fakeHome)).toEqual([])

    const wsValid = makeTempDir('scry-ws-hook-valid-')
    mkdirSync(join(wsValid, '.agents', 'scripts'), { recursive: true })
    writeFileSync(join(wsValid, '.agents', 'scripts', 'allow.sh'), '#!/bin/sh\nprintf \'{"decision":"allow"}\\n\'\n', 'utf8')
    writeFileSync(
      join(wsValid, '.agents', 'hooks.json'),
      JSON.stringify({
        local: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'sh scripts/allow.sh' }] }] }
      }),
      'utf8'
    )
    mkdirSync(join(fakeHome, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(fakeHome, '.gemini', 'config', 'user-allow.sh'), '#!/bin/sh\necho \'{"decision":"allow"}\'\n', 'utf8')
    writeFileSync(
      join(fakeHome, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({
        user: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'sh user-allow.sh' }] }] }
      }),
      'utf8'
    )
    expect(collectAllowCapablePreToolUseMatchers(wsValid, fakeHome).sort()).toEqual(['run_command', 'write_file'])
  })

  it('恶意回溯 matcher 与超长 matcher 不会卡住主进程且返回不匹配，常规通配与竖线分隔仍正常匹配', () => {
    const runMatcher = (matchers: string[], toolName: string): boolean => {
      const events: TraceEvent[] = []
      const translator = new AntigravityEventTranslator('matcher-test', (e) => events.push(e), {
        permissionMode: 'default',
        allowCapablePreToolUseMatchers: matchers
      })
      translator.handleNotification('session/update', {
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc-m', name: toolName, kind: 'execute' }
      })
      translator.handleNotification('session/update', {
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-m', status: 'completed' }
      })
      const result = events.find((e) => e.stage === 'tool_result')
      return result?.runtimeMetadata?.approvalSource === 'hook'
    }

    const evilStart = Date.now()
    expect(runMatcher(['(a+)+b'], `${'a'.repeat(30)}!`)).toBe(false)
    expect(Date.now() - evilStart).toBeLessThan(100)

    const longTool = 'a'.repeat(200)
    expect(runMatcher([longTool], longTool)).toBe(false)

    // 3. agy 文档支持的常规 matcher（*、空串、精确、竖线分隔、前缀 .* 通配）正常匹配
    expect(runMatcher(['*'], 'run_command')).toBe(true)
    expect(runMatcher([''], 'run_command')).toBe(true)
    expect(runMatcher(['run_command|view_file'], 'run_command')).toBe(true)
    expect(runMatcher(['run_command\\|view_file'], 'view_file')).toBe(true)
    expect(runMatcher(['browser_.*'], 'browser_click')).toBe(true)
    expect(runMatcher(['browser_.*'], 'run_command')).toBe(false)
  })
})

describe('W8 第三轮后续项 3：相对路径 GEMINI_HOME 拒绝目录探测 + 首尾空格处理一致', () => {
  it('显式放行相对路径 GEMINI_HOME 时，runControls 与 commands 拒绝探测且绝不启动 agy（不退回 fallback 键）', async () => {
    const fakeHome = makeTempDir('scry-home-cat-rel-')
    const ws = makeTempDir('scry-ws-cat-rel-')
    const { binPath, recordPath } = installFakeAgy({ reply: 'should-not-spawn' })
    process.env.SCRY_AGY_PATH = binPath
    process.env.SCRY_PROVIDER_ENV_ALLOW = 'antigravity:GEMINI_HOME'
    process.env.GEMINI_HOME = './relative-gemini'

    const adapter = createAntigravityAdapter(fakeHome)
    const controls = await adapter.runControls!.read({ providerId: 'antigravity', cwd: ws })
    expect(controls.state).toBe('unknown')
    expect(controls.data).toBeNull()
    expect(controls.reason).toMatch(/GEMINI_HOME 必须是绝对路径/)
    expect(existsSync(recordPath)).toBe(false)

    const commands = await adapter.commands!.list({ providerId: 'antigravity', cwd: ws })
    expect(commands.state).toBe('unknown')
    expect(commands.data).toBeNull()
    expect(commands.reason).toMatch(/GEMINI_HOME 必须是绝对路径/)
    expect(existsSync(recordPath)).toBe(false)
  })

  it('GEMINI_HOME 检查与传给 agy 使用完全一致的值（不做隐式 trim：前导空格/纯空格按相对路径拒绝，尾随空格与启动环境一致）', async () => {
    const fakeHome = makeTempDir('scry-home-ws-')
    const baseDir = makeTempDir('scry-ws-trim-')
    const validAbs = join(baseDir, 'real-gemini')
    mkdirSync(validAbs, { recursive: true })

    // 1. 前导空格：" /abs/path" 在 POSIX/agy 中是相对路径，Scry 绝不能 trim 成 "/abs/path"
    const leadingSpaceEnv: Record<string, string> = {
      SCRY_PROVIDER_ENV_ALLOW: 'antigravity:GEMINI_HOME',
      GEMINI_HOME: ` ${validAbs}`
    }
    const launchLeading = buildAntigravityLaunchEnv(leadingSpaceEnv)
    expect(launchLeading.GEMINI_HOME).toBe(` ${validAbs}`)
    expect(() => antigravityGeminiRoot(fakeHome, launchLeading)).toThrow(/GEMINI_HOME 必须是绝对路径/)
    expect(() => antigravityEffectiveGeminiRoot(fakeHome, leadingSpaceEnv)).toThrow(/GEMINI_HOME 必须是绝对路径/)

    // 2. 纯空格："   " 在 POSIX/agy 中是非空相对路径，Scry 绝不能 trim 成空串后静默回退 ~/.gemini
    const blankOnlyEnv: Record<string, string> = {
      SCRY_PROVIDER_ENV_ALLOW: 'antigravity:GEMINI_HOME',
      GEMINI_HOME: '   '
    }
    const launchBlank = buildAntigravityLaunchEnv(blankOnlyEnv)
    expect(launchBlank.GEMINI_HOME).toBe('   ')
    expect(() => antigravityGeminiRoot(fakeHome, launchBlank)).toThrow(/GEMINI_HOME 必须是绝对路径/)
    expect(() => antigravityEffectiveGeminiRoot(fakeHome, blankOnlyEnv)).toThrow(/GEMINI_HOME 必须是绝对路径/)

    // 3. 合法绝对路径带尾随空格：检查路径与传给 agy 的 GEMINI_HOME 逐字节一致
    const trailingSpaceDir = join(baseDir, 'gemini-space ')
    mkdirSync(trailingSpaceDir, { recursive: true })
    const trailingEnv: Record<string, string> = {
      SCRY_PROVIDER_ENV_ALLOW: 'antigravity:GEMINI_HOME',
      GEMINI_HOME: trailingSpaceDir
    }
    const launchTrailing = buildAntigravityLaunchEnv(trailingEnv)
    expect(launchTrailing.GEMINI_HOME).toBe(trailingSpaceDir)
    expect(antigravityGeminiRoot(fakeHome, launchTrailing)).toBe(launchTrailing.GEMINI_HOME)
    expect(antigravityEffectiveGeminiRoot(fakeHome, trailingEnv)).toBe(launchTrailing.GEMINI_HOME)
  })
})
