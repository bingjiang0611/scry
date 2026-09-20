import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import type { ParsedTurn } from '../normalize'
import { piProfileForExecutable } from '../pi-agent-profiles'
import * as shellEnvironment from '../claude-locate'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import {
  commitManagedRecorderTurn,
  prepareManagedRecorderTurn,
  recoverManagedRecorderTurns
} from '../../core/turn-recorder/managed'
import { listRecords, stableHash } from '../../core/turn-recorder/store'
import {
  createPiAdapter,
  PI_RPC_STARTUP_TIMEOUT_MS,
  piRpcEnvironment,
  piUserEntryIdAfterBaseline,
  probePiAgent,
  questionFromExtension
} from './pi'

const fixtureSource = `#!/usr/bin/env node
require('node:fs').appendFileSync(process.cwd() + '/fixture-starts', String(process.pid) + '\\n')
if (process.argv.includes('--approve') || process.argv.includes('--no-approve')) {
  process.stderr.write('Scry must not override Pi project trust')
  process.exit(64)
}
let buffer = ''
let leafId = 'active-leaf'
let sessionId = 'pi-session-1'
let entrySeq = 0
let promptMessage = ''
let acknowledgePrompt
const entries = [
  { type: 'message', id: 'active-user', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user' } },
  { type: 'message', id: 'active-leaf', parentId: 'active-user', timestamp: new Date().toISOString(), message: { role: 'assistant' } },
  { type: 'message', id: 'abandoned-user', parentId: 'active-leaf', timestamp: new Date().toISOString(), message: { role: 'user' } }
]
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!raw) continue
    const command = JSON.parse(raw)
    const response = (data) => send({ type: 'response', id: command.id, command: command.type, success: true, ...(data ? { data } : {}) })
    if (command.type === 'get_state') {
      if (promptMessage === 'final-state-hang') {
        send({ type: 'extension_ui_request', id: 'final-state-wait', method: 'select', title: 'Final state', options: ['Continue'] })
        continue
      }
      if (require('node:fs').existsSync(process.cwd() + '/hold-startup')) {
        send({ type: 'extension_ui_request', id: 'startup-wait', method: 'select', title: 'Loading', options: ['Wait'] })
        continue
      }
      const state = {
        model: { provider: 'test-provider', id: 'test-model' },
        thinkingLevel: 'high',
        sessionId,
        sessionFile: '/tmp/pi-session-1.jsonl',
        cwd: process.cwd()
      }
      if (promptMessage === 'stop-before-final-state') {
        require('node:fs').writeFileSync(process.cwd() + '/final-state-requested', '')
      }
      response(state)
    }
    else if (command.type === 'get_available_models') response({ models: [{
      provider: 'openai-codex', id: 'test-model', name: 'Test Model', contextWindow: 200000,
      thinkingLevelMap: { off: null, high: 'high' }
    }] })
    else if (command.type === 'get_available_thinking_levels') response({ levels: ['off', 'high'] })
    else if (command.type === 'get_commands') response({ commands: [
      {
        name: 'skill:review', description: 'Review code', source: 'skill',
        sourceInfo: { scope: 'project', path: '/repo/.pi/agent/skills/review/SKILL.md' }
      },
      {
        name: 'skill:rate-workflow', description: 'Run rate workflow', source: 'skill',
        sourceInfo: { scope: 'project', path: '/repo/.claude/skills/rate-workflow/SKILL.md' }
      }
    ] })
    else if (command.type === 'fork') {
      const target = entries.find((entry) => entry.id === command.entryId && entry.message?.role === 'user')
      if (!target) send({ type: 'response', id: command.id, command: command.type, success: false, error: 'invalid fork target' })
      else {
        sessionId = 'pi-session-forked'
        leafId = target.parentId
        response({ text: target.message.content ?? '', cancelled: false })
      }
    }
    else if (command.type === 'clone') {
      sessionId = 'pi-session-cloned'
      response({ cancelled: false })
    }
    else if (command.type === 'get_entries') {
      const start = command.since == null ? 0 : entries.findIndex((entry) => entry.id === command.since) + 1
      if (command.since != null && start === 0) {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'invalid cursor' })
      } else response({ entries: entries.slice(start), leafId })
    }
    else if (command.type === 'prompt') {
      promptMessage = command.message
      if (command.message === 'transport-exit') process.exit(17)
      if (command.message === 'preflight-reject') {
        send({ type: 'response', id: command.id, command: command.type, success: false, error: 'preflight rejected' })
        continue
      }
      if (command.message !== 'no-entry' && command.message !== 'late-entry') {
        if (command.message === 'with-compact') {
          const compact = { type: 'compaction', id: 'compact-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString() }
          entries.push(compact)
          leafId = compact.id
        }
        const entry = {
          type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId, timestamp: new Date().toISOString(),
          message: { role: 'user', content: command.message.startsWith('/skill:') ? 'expanded skill content' : command.message }
        }
        entries.push(entry)
        leafId = entry.id
      }
      if (command.message === 'late-prompt-ack' || command.message === 'late-entry') {
        acknowledgePrompt = response
        if (command.message === 'late-entry') response()
        send({ type: 'extension_ui_request', id: 'delayed-release', method: 'select', title: 'Release?', options: ['Continue'] })
        continue
      }
      response()
      if (command.message === 'provider-fetch-failed' || command.message === 'provider-http-413') {
        const payloadTooLarge = command.message === 'provider-http-413'
        send({ type: 'message_start', message: { role: 'assistant' } })
        send({ type: 'message_end', message: {
          role: 'assistant', provider: 'openai-codex', model: 'test-model', stopReason: 'error',
          errorMessage: payloadTooLarge ? 'Qoder: http_413' : 'fetch failed', content: [],
          ...(payloadTooLarge ? {} : { diagnostics: [{ type: 'provider_transport_failure', error: { message: 'WebSocket error' } }] }),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
        } })
        send({ type: 'agent_end', willRetry: false })
        send({ type: 'agent_settled' })
        continue
      }
      if (command.message === 'hang') continue
      if (command.message === 'stop-before-final-state') {
        send({ type: 'message_start', message: { role: 'assistant' } })
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'started' } })
        continue
      }
      if (command.message === 'long-active') {
        let ticks = 0
        const timer = setInterval(() => {
          ticks += 1
          send({ type: 'status_update', status: 'working', ticks })
          if (ticks === 5) {
            clearInterval(timer)
            send({ type: 'agent_settled' })
          }
        }, 20)
        continue
      }
      if (command.message === 'oversized-unframed') {
        process.stdout.write('x'.repeat(2 * 1024 * 1024))
        continue
      }
      if (command.message === 'large-event') send({ type: 'unknown_large', payload: 'x'.repeat(17 * 1024 * 1024) })
      if (command.message === 'pending-question') {
        send({ type: 'extension_ui_request', id: 'question-late', method: 'select', title: 'Pick one', options: ['One'] })
      }
      send({ type: 'message_start', message: { role: 'assistant' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'think' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'ing' } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' + String.fromCodePoint(0x2028) + 'world' } })
      send({ type: 'tool_execution_start', toolCallId: 'tool-read', toolName: 'read', args: { path: 'README.md' } })
      send({ type: 'tool_execution_end', toolCallId: 'tool-read', toolName: 'read', result: command.message === 'large-tool' ? '原文😀'.repeat(60_000) + 'PI-TOOL-END' : 'contents', isError: false })
      send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'subagent', args: { task: 'inspect' } })
      send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'subagent', result: { content: [{ type: 'text', text: 'done' }] }, isError: false })
      const providerAborted = command.message === 'provider-aborted'
      send({ type: 'message_end', message: {
        role: 'assistant', provider: 'openai-codex', model: 'test-model',
        stopReason: providerAborted ? 'aborted' : 'stop',
        ...(providerAborted ? { errorMessage: 'Qoder: aborted' } : {}),
        content: providerAborted ? [] : [{ type: 'text', text: 'hello world' }],
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } }
      } })
      send({ type: 'agent_end', willRetry: false })
      setTimeout(() => send({ type: 'agent_settled' }), 20)
    } else if (command.type === 'extension_ui_response' && command.id === 'delayed-release') {
      if (promptMessage === 'late-entry') {
        const entry = { type: 'message', id: 'pi-user-' + (++entrySeq), parentId: leafId, message: { role: 'user' } }
        entries.push(entry)
        leafId = entry.id
      } else acknowledgePrompt()
      send({ type: 'agent_settled' })
    } else if (command.type === 'abort' && promptMessage === 'stop-before-final-state') {
      send({ type: 'agent_settled' })
    } else response()
  }
})
`

function withFixture<T>(
  run: (profile: ReturnType<typeof piProfileForExecutable>, cwd: string) => Promise<T>,
  executableName = 'fixture-pi'
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-pi-rpc-'))
  const executable = join(dir, executableName)
  writeFileSync(executable, fixtureSource)
  chmodSync(executable, 0o755)
  return run(piProfileForExecutable(executable), dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function withRotomFixture<T>(run: (profile: ReturnType<typeof piProfileForExecutable>, cwd: string) => Promise<T>): Promise<T> {
  return withFixture(run, 'rotom')
}

describe('Pi RPC Provider', () => {
  it('restores structured multi-select choices from an extension text-input prompt', () => {
    const title = '[不满意点] 你最想改善什么？（可多选）\n\n1. 布局不均衡 — 卡片留白混乱\n2. 视觉风格不够精致 — 层级与质感不足'
    const request = questionFromExtension('run-input', {
      type: 'extension_ui_request',
      id: 'input-1',
      method: 'input',
      title,
      placeholder: '1,3'
    })

    expect(request?.questions[0]).toEqual({
      header: '不满意点',
      question: '你最想改善什么？',
      multiSelect: true,
      options: [
        { label: '布局不均衡', description: '卡片留白混乱', answerValue: '1' },
        { label: '视觉风格不够精致', description: '层级与质感不足', answerValue: '2' }
      ]
    })
  })

  it('keeps a plain extension input as a direct free-text question', () => {
    const request = questionFromExtension('run-input', {
      id: 'input-2',
      method: 'input',
      title: '请输入发布说明',
      placeholder: '一句话概括'
    })

    expect(request?.questions[0]).toEqual({
      header: '回答',
      question: '请输入发布说明',
      multiSelect: false,
      options: [],
      inputMode: 'singleline',
      placeholder: '一句话概括'
    })
  })

  it('allows cold session startup to exceed the ordinary 15 second command deadline', () => {
    expect(PI_RPC_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('pins the packaged Pi runtime from supported PATH bootstrap forms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-bootstrap-'))
    try {
      const packageRoot = join(dir, 'node_modules', '@example', 'pi-coding-agent')
      const runtime = join(packageRoot, 'dist', 'cli.js')
      const launcher = join(dir, 'pi-agent')
      const bootstrap = join(dir, 'pi')
      mkdirSync(join(packageRoot, 'dist'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      chmodSync(launcher, 0o755)
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@example/pi-coding-agent',
        bin: { pi: 'dist/cli.js' }
      }), { flag: 'wx' })
      writeFileSync(runtime, '#!/usr/bin/env node\n', { flag: 'wx' })
      chmodSync(runtime, 0o755)
      writeFileSync(bootstrap, `#!/bin/sh\n: "\${PI_AGENT_PI:=${runtime}}"\nexport PI_AGENT_PI\nexec ${launcher} "$@"\n`)
      chmodSync(bootstrap, 0o755)

      const profile = piProfileForExecutable(launcher)
      expect((await piRpcEnvironment(profile, { PATH: dir, HOME: dir })).PI_AGENT_PI).toBe(realpathSync(runtime))

      writeFileSync(bootstrap, `#!/bin/sh\nPI_AGENT_PI=${runtime} \\\n\texec ${launcher} "$@"\n`)
      expect((await piRpcEnvironment(profile, { PATH: dir, HOME: dir })).PI_AGENT_PI).toBe(realpathSync(runtime))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('selects a compatible Node later on PATH for Pi launchers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-node-'))
    try {
      const oldBin = join(dir, 'old', 'bin')
      const newBin = join(dir, 'new', 'bin')
      const launcher = join(dir, 'pi-agent')
      const nativeWrapper = join(dir, 'pi')
      const rotomLauncher = join(dir, 'rotom')
      mkdirSync(oldBin, { recursive: true })
      mkdirSync(newBin, { recursive: true })
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      writeFileSync(nativeWrapper, '#!/bin/sh\nexit 0\n')
      writeFileSync(rotomLauncher, '#!/bin/sh\nexit 0\n')
      writeFileSync(join(oldBin, 'node'), '#!/bin/sh\nprintf "22.22.1\\n"\n')
      writeFileSync(join(newBin, 'node'), '#!/bin/sh\nprintf "24.18.0\\n"\n')
      chmodSync(launcher, 0o755)
      chmodSync(nativeWrapper, 0o755)
      chmodSync(rotomLauncher, 0o755)
      chmodSync(join(oldBin, 'node'), 0o755)
      chmodSync(join(newBin, 'node'), 0o755)

      const profile = piProfileForExecutable(launcher)
      expect((await piRpcEnvironment(profile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        PI_AGENT_PI: '/already/pinned/pi'
      })).PI_AGENT_NODE).toBe(realpathSync(join(newBin, 'node')))
      expect((await piRpcEnvironment(profile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        PI_AGENT_NODE: join(oldBin, 'node')
      })).PI_AGENT_NODE).toBe(join(oldBin, 'node'))
      const nativeProfile = {
        id: 'pi:default',
        label: 'Pi',
        executable: nativeWrapper
      }
      await expect(piRpcEnvironment(nativeProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir
      })).resolves.toMatchObject({ PI_AGENT_NODE: realpathSync(join(newBin, 'node')) })

      const rotomProfile = piProfileForExecutable(rotomLauncher)
      const compatibleNode = realpathSync(join(newBin, 'node'))
      const rotomEnv = await piRpcEnvironment(rotomProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir
      })
      expect(rotomEnv).toMatchObject({ ROTOM_NODE: compatibleNode })
      expect(rotomEnv.PI_AGENT_NODE).toBeUndefined()
      await expect(piRpcEnvironment(rotomProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        PI_AGENT_NODE: join(oldBin, 'node')
      })).resolves.toMatchObject({
        PI_AGENT_NODE: join(oldBin, 'node'),
        ROTOM_NODE: compatibleNode
      })
      expect((await piRpcEnvironment(rotomProfile, {
        PATH: `${oldBin}${delimiter}${newBin}`,
        HOME: dir,
        ROTOM_NODE: '/configured/node'
      })).ROTOM_NODE).toBe('/configured/node')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes billing-admin credentials from the Pi subprocess environment', async () => {
    const profile = { id: 'pi:test', label: 'Pi', executable: '/usr/bin/pi' }
    const env = await piRpcEnvironment(profile, {
      PATH: '/usr/bin',
      HOME: '/tmp',
      ANTHROPIC_ADMIN_API_KEY: 'anthropic-admin',
      OPENAI_ADMIN_API_KEY: 'openai-admin',
      QODER_ADMIN_API_KEY: 'qoder-admin',
      QODER_ORGANIZATION_ID: 'org',
      QODER_MEMBER_ID: 'member'
    })
    expect(env).not.toHaveProperty('ANTHROPIC_ADMIN_API_KEY')
    expect(env).not.toHaveProperty('OPENAI_ADMIN_API_KEY')
    expect(env).not.toHaveProperty('QODER_ADMIN_API_KEY')
    expect(env).not.toHaveProperty('QODER_ORGANIZATION_ID')
    expect(env).not.toHaveProperty('QODER_MEMBER_ID')
  })

  it('does not infer PI_AGENT_PI from an unverified shell assignment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-pi-bootstrap-'))
    try {
      const launcher = join(dir, 'pi-agent')
      const bootstrap = join(dir, 'pi')
      const unrelated = join(dir, 'not-a-package-cli')
      writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
      writeFileSync(unrelated, '#!/bin/sh\nexit 0\n')
      writeFileSync(bootstrap, `#!/bin/sh\nPI_AGENT_PI=${unrelated}\nexec ${launcher} "$@"\n`)
      chmodSync(launcher, 0o755)
      chmodSync(unrelated, 0o755)
      chmodSync(bootstrap, 0o755)

      const env = await piRpcEnvironment(piProfileForExecutable(launcher), { PATH: dir, HOME: dir })
      expect(env.PI_AGENT_PI).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('probes native models, permissions, commands and skills without overriding Pi project trust', async () => {
    await withFixture(async (profile, cwd) => {
      const probe = await probePiAgent(profile, cwd)
      expect(probe).toMatchObject({ levels: ['off', 'high'], models: [{ id: 'test-model' }] })
      await expect(probePiAgent(profile)).resolves.toMatchObject({ state: { cwd: homedir() } })

      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.runControls!.read({ providerId: 'pi', agentProfileId: profile.id, cwd })).resolves.toMatchObject({
        state: 'ready',
        agentProfileId: profile.id,
        data: {
          models: [expect.objectContaining({ model: { providerId: 'openai-codex', id: 'test-model' } })],
          permissions: [expect.objectContaining({ id: 'full_access' })]
        }
      })
      await expect(adapter.skills!.list({ providerId: 'pi', agentProfileId: profile.id, cwd })).resolves.toMatchObject({
        data: expect.arrayContaining([
          { name: 'review', dir: '/repo/.pi/agent/skills/review', scope: 'project', description: 'Review code', enabled: true }
        ])
      })
      await expect(adapter.describe()).resolves.toMatchObject({ capabilities: { mcp: 'none' } })
      expect(adapter.mcp).toBeUndefined()
    })
  }, 20_000)

  it('enriches archived Pi context only from the exact upstream provider and model window', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const turns = await adapter.sessionEvidence!.enrich(
        { providerId: 'pi', agentProfileId: profile.id, cwd, externalSessionId: 'pi-session-1' },
        [{
          userText: 'work',
          items: [{
            id: 'result-history', runId: 'run-history', ts: new Date().toISOString(),
            kind: 'harness', stage: 'result', contextTokens: 10, contextModel: 'test-model',
            upstreamProvider: 'openai-codex', modelUsage: [{ model: 'test-model', upstreamProvider: 'openai-codex' }]
          }]
        }]
      )

      expect(turns[0].items[0]).toMatchObject({
        contextTokens: 10,
        contextModel: 'test-model',
        contextProvider: 'openai-codex',
        contextUsageSource: 'pi_rpc_archive_usage+current_model_catalog',
        contextUsageQuality: 'inferred',
        modelUsage: [{ model: 'test-model', upstreamProvider: 'openai-codex', contextWindow: 200_000 }]
      })
    })
  }, 10_000)

  it('opens Rotom Qoder history without probing again when the archive already proves context usage', async () => {
    const resolveProfile = vi.fn(async () => undefined)
    const adapter = createPiAdapter({ listProfiles: async () => [], resolveProfile })
    const turns: ParsedTurn[] = [{
      userText: 'work',
      items: [{
        id: 'result-history', runId: 'run-history', ts: new Date().toISOString(),
        kind: 'harness', stage: 'result', contextTokens: 5_060, contextModel: 'ultimate',
        contextProvider: 'qoder', contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact',
        modelUsage: [{ model: 'ultimate', upstreamProvider: 'qoder', contextWindow: 272_000 }]
      }]
    }]

    await expect(adapter.sessionEvidence!.enrich(
      { providerId: 'pi', agentProfileId: 'pi:rotom', cwd: '/repo', externalSessionId: 'pi-session-1' },
      turns
    )).resolves.toBe(turns)
    expect(resolveProfile).not.toHaveBeenCalled()
  })

  it('forks Pi before the edited user entry and returns the new native session', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.forkLastTurn!.fork({
        sourceSessionId: 'pi-session-1',
        originalPrompt: 'old prompt',
        replaceRunId: 'run-last',
        replaceProviderTurnId: 'abandoned-user',
        replaceForkTurnId: 'abandoned-user',
        previousProviderTurnId: 'prompt-previous',
        previousForkTurnId: 'prompt-previous',
        agentProfileId: profile.id,
        cwd
      })).resolves.toEqual({ externalSessionId: 'pi-session-forked' })
    })
  })

  it('clones Pi at the active leaf after the selected final turn', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.forkSession!.fork({
        providerId: 'pi',
        sourceSessionId: 'pi-session-1',
        sourceRunId: 'run-active',
        sourceProviderTurnId: 'active-user',
        sourceForkTurnId: 'active-user',
        agentProfileId: profile.id,
        cwd
      })).resolves.toEqual({ externalSessionId: 'pi-session-cloned' })
    })
  })

  it('waits for agent_settled and normalizes stream, subagent tools, session and usage', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const onSession = vi.fn()
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-1',
        prompt: 'hello',
        cwd,
        agentProfileId: profile.id,
        attachments: [],
        model: { providerId: 'test-provider', id: 'test-model' },
        effort: 'high',
        permissionMode: 'full_access',
        emit: (event) => events.push(event),
        onExternalSessionId: onSession
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', stopped: false, status: 'completed'
      })
      expect(handle.getProviderTurnId?.()).toBe('pi-user-1')
      expect(onSession).toHaveBeenCalledWith('pi-session-1')
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'model', stage: 'thinking', thinking: 'think', messageId: expect.any(String) }),
        expect.objectContaining({ kind: 'model', stage: 'text_delta', text: 'hello\u2028world', messageId: expect.any(String) }),
        expect.objectContaining({
          kind: 'tool', tool: 'read', toolUseId: 'tool-read', fileOp: 'read', filePath: 'README.md'
        }),
        expect.objectContaining({ kind: 'agent', tool: 'Agent', toolUseId: 'tool-1' }),
        expect.objectContaining({
          kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 4, costUsd: 0.01,
          contextTokens: 10, contextModel: 'test-model', contextProvider: 'openai-codex',
          contextUsageSource: 'pi_rpc_assistant_usage', contextUsageQuality: 'exact',
          billingProvider: 'codex', upstreamProvider: 'openai-codex',
          modelUsage: [expect.objectContaining({
            billingProvider: 'codex', upstreamProvider: 'openai-codex', contextWindow: 200000
          })]
        })
      ]))
      const streamedModelEvents = events.filter((event) =>
        event.kind === 'model' && (event.stage === 'thinking' || event.stage === 'text_delta')
      )
      expect(streamedModelEvents.filter((event) => event.stage === 'thinking').map((event) => event.thinking))
        .toEqual(['think', 'ing'])
      const messageIds = [...new Set(streamedModelEvents.map((event) => event.messageId))]
      expect(messageIds).toHaveLength(1)
      expect(messageIds[0]).toMatch(/^pi:run-1:assistant-\d+$/)
    })
  }, 15_000)

  it('does not truncate native Pi tool results before canonical persistence', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-large-tool', prompt: 'large-tool', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })
      await expect(handle.promise).resolves.toMatchObject({ status: 'completed' })
      const output = events.find((event) => event.toolUseId === 'tool-read' && event.stage === 'tool_result')?.output
      expect(typeof output).toBe('string')
      expect((output as string).length).toBeGreaterThan(200_000)
      expect(output).toContain('PI-TOOL-END')
      expect(output).not.toContain('truncated by Scry')
    })
  }, 15_000)

  it('keeps slow native startup owned beyond 60 seconds and remains explicitly stoppable', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'hold-startup'), '')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let received!: () => void
      const startupObserved = new Promise<void>((resolve) => { received = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-startup-wait', prompt: 'must not execute', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        requestUserInput: async (question, signal) => {
          received()
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          return { runId: question.runId, questionId: question.questionId, behavior: 'cancelled' }
        }
      })
      const terminal = vi.fn()
      void handle.promise.then(terminal, terminal)
      try {
        await startupObserved
        await vi.advanceTimersByTimeAsync(61_000)
        expect(terminal).not.toHaveBeenCalled()
        vi.useRealTimers()
        handle.forceKill?.()
        await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
        expect(handle.getProviderTurnId?.()).toBeUndefined()
      } finally {
        vi.useRealTimers()
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  }, 15_000)

  it.each(['late-prompt-ack', 'late-entry'])('keeps %s owned across 31 minutes of silence', async (prompt) => {
    await withFixture(async (profile, cwd) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let release!: () => void
      let received!: () => void
      const questionReceived = new Promise<void>((resolve) => { received = resolve })
      const answer = new Promise<void>((resolve) => { release = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-delayed', prompt, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        requestUserInput: async (question) => {
          received()
          await answer
          return { runId: question.runId, questionId: question.questionId, behavior: 'answered', answers: { 'Release?': 'Continue' } }
        }
      })
      const terminal = vi.fn()
      void handle.promise.then(terminal, terminal)
      try {
        await questionReceived
        await vi.advanceTimersByTimeAsync(31 * 60_000)
        expect(terminal).not.toHaveBeenCalled()
        vi.useRealTimers()
        release()
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
      } finally {
        vi.useRealTimers()
        release()
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  }, 15_000)

  it('does not turn a settled native run into failure when final metadata times out', async () => {
    await withFixture(async (profile, cwd) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const events: TraceEvent[] = []
      let observed!: () => void
      const finalStateRequested = new Promise<void>((resolve) => { observed = resolve })
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-final-state', prompt: 'final-state-hang', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event),
        requestUserInput: async (question) => {
          observed()
          return { runId: question.runId, questionId: question.questionId, behavior: 'answered', answers: { 'Final state': 'Continue' } }
        }
      })
      try {
        await finalStateRequested
        await vi.advanceTimersByTimeAsync(16_000)
        await expect(handle.promise).resolves.toMatchObject({ status: 'completed', providerTurnId: 'pi-user-1' })
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'harness', stage: 'runtime:telemetry_degraded',
          runtimeMetadata: expect.objectContaining({ capability: 'final_state' })
        }))
      } finally {
        vi.useRealTimers()
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
      }
    })
  }, 15_000)

  it('does not impose a settlement duration deadline', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const startedAt = Date.now()
      const handle = adapter.run({
        runId: 'run-long-active', prompt: 'long-active', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', status: 'completed'
      })
      expect(Date.now() - startedAt).toBeGreaterThan(70)
    })
  }, 15_000)

  it('reports an upstream aborted settlement as a failure instead of a completed turn', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-provider-aborted', prompt: 'provider-aborted', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).rejects.toMatchObject({
        message: 'Qoder: aborted',
        brief: expect.objectContaining({ stage: 'runtime' })
      })
      expect(handle.getExternalSessionId()).toBe('pi-session-1')
      expect(handle.getProviderTurnId?.()).toBe('pi-user-1')
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness',
          stage: 'result',
          isError: true,
          text: 'Qoder: aborted',
          providerStopReason: 'aborted'
        })
      ]))
    })
  }, 15_000)

  it('classifies Qoder 413 and points to the failed-turn recovery branch', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-provider-http-413', prompt: 'provider-http-413', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).rejects.toMatchObject({
        message: 'Qoder: http_413',
        brief: expect.objectContaining({ nextAction: expect.stringContaining('从失败处恢复') })
      })
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'harness', stage: 'result', isError: true,
          terminationReason: 'input_context_overflow'
        })
      ]))
    })
  }, 15_000)

  it('reuses a settled Rotom RPC across turns and invalidates it with the session context', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = (runId: string, prompt: string, resume?: string) => adapter.run({
        runId, prompt, cwd, resume, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise
      try {
        const first = await request('run-rotom-first', 'first')
        await expect(request('run-rotom-second', 'second', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-2', status: 'completed'
        })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(1)

        await adapter.invalidateContext?.({
          providerId: 'pi', agentProfileId: profile.id, cwd, externalSessionId: first.externalSessionId
        })
        await expect(request('run-rotom-third', 'third', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: 'pi-session-1', status: 'completed'
        })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      } finally {
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it.each([undefined, '登录 shell 环境采集失败：超时（15s）；修复后重新发送将重试采集'])('preserves transport/context evidence and launch-time shell failure: %s', async (envError) => {
    await withRotomFixture(async (profile, cwd) => {
      const envErrorSpy = vi.spyOn(shellEnvironment, 'shellEnvError').mockReturnValue(envError)
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = (runId: string, prompt: string, resume?: string) => adapter.run({
        runId, prompt, cwd, resume, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => {
          events.push(event)
          if (event.runId === 'run-rotom-fetch-failure' && event.stage === 'runtime:init') {
            // Another session may retry shell capture while this process is running.
            envErrorSpy.mockReturnValue(envError ? undefined : 'later unrelated shell failure')
          }
        }
      }).promise
      try {
        const first = await request('run-rotom-before-failure', 'first')
        await expect(request('run-rotom-fetch-failure', 'provider-fetch-failed', first.externalSessionId)).rejects.toMatchObject({
          message: 'fetch failed (WebSocket error)',
          brief: expect.objectContaining({ nextAction: envError ?? expect.stringContaining('WebSocket 与 SSE') })
        })
        expect(events.find((event) => event.runId === 'run-rotom-fetch-failure' && event.stage === 'result')).toMatchObject({
          isError: true,
          text: 'fetch failed (WebSocket error)',
          contextTokens: undefined,
          runtimeMetadata: expect.objectContaining({ transportError: 'WebSocket error', shellEnvError: envError ?? null })
        })
        await expect(request('run-rotom-after-failure', 'after', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: 'pi-session-1', status: 'completed'
        })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(1)
      } finally {
        envErrorSpy.mockRestore()
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('starts a fresh Rotom RPC when the launch environment changes, but keeps the session', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const base = { ...process.env } as Record<string, string>
      const envSpy = vi.spyOn(shellEnvironment, 'shellEnv').mockReturnValue(base)
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const request = (runId: string, resume?: string) => adapter.run({
        runId, prompt: 'first', cwd, resume, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise
      try {
        const first = await request('before-env-recovery')
        envSpy.mockReturnValue({ ...base, HTTPS_PROXY: 'http://127.0.0.1:12345' })
        await expect(request('after-env-recovery', first.externalSessionId)).resolves.toMatchObject({
          externalSessionId: first.externalSessionId, status: 'completed'
        })
        const starts = readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')
        expect(starts).toHaveLength(2)
        expect(() => process.kill(Number(starts[0]), 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        await request('same-env', first.externalSessionId)
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      } finally {
        envSpy.mockRestore()
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('starts a fresh Rotom RPC after the active transport process exits', async () => {
    await withRotomFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      try {
        await expect(adapter.run({
          runId: 'run-rotom-exit', prompt: 'transport-exit', cwd, resume: 'pi-session-1', agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn()
        }).promise).rejects.toThrow()
        await expect(adapter.run({
          runId: 'run-rotom-recovered', prompt: 'recovered', cwd, resume: 'pi-session-1', agentProfileId: profile.id,
          attachments: [], permissionMode: 'full_access', emit: vi.fn()
        }).promise).resolves.toMatchObject({ status: 'completed' })
        expect(readFileSync(join(cwd, 'fixture-starts'), 'utf8').trim().split('\n')).toHaveLength(2)
      } finally {
        await adapter.dispose?.()
      }
    })
  }, 15_000)

  it('accepts valid JSONL events larger than 16 MiB without terminating the Pi run', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-large-event', prompt: 'large-event', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })

      await expect(handle.promise).resolves.toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', status: 'completed'
      })
    })
  }, 30_000)

  it('terminates an unframed JSONL message after the explicit 64 MiB residency boundary', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({
        listProfiles: async () => [profile],
        resolveProfile: async () => profile,
        rpcMaxFrameBytes: 1024 * 1024
      })
      const handle = adapter.run({
        runId: 'run-oversized-unframed', prompt: 'oversized-unframed', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })

      await expect(handle.promise).rejects.toThrow('未完成 JSONL 消息超过 64 MiB')
    })
  }, 30_000)

  it('proves an explicit skill through get_commands and emits a skill event', async () => {
    await withFixture(async (profile, cwd) => {
      const events: TraceEvent[] = []
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-skill', prompt: '/skill:rate-workflow 85781174', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: (event) => events.push(event)
      })

      await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'pi-user-1' })
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'skill', stage: 'skill:rate-workflow', tool: 'Skill', name: 'rate-workflow',
          input: expect.objectContaining({ source: 'explicit_user_input' })
        })
      ]))
    })
  }, 15_000)

  it('opens a managed Pi lifecycle before prompting and returns its authoritative entry id', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        workspaceId: 'pi-managed-fixture',
        dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const prompt = '/skill:rate-workflow 85781174'
      const runId = 'run-managed-pi'
      const events: TraceEvent[] = []
      const startedAtMs = Date.now()
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId, prompt, cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', managedRecorder: true,
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(prompt).digest('hex')
        },
        emit: (event) => events.push(event)
      })

      const result = await handle.promise
      expect(result).toMatchObject({
        externalSessionId: 'pi-session-1', providerTurnId: 'pi-user-1', status: 'completed'
      })
      const completedAtMs = Date.now()
      const evidence = aggregateTurnEvidence({ userText: prompt, events, source: 'scry_provider_adapter' })
      const timing = {
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs
      }
      const archiveFingerprint = stableHash({ runId, evidence, timing })
      const prepared = await prepareManagedRecorderTurn({
        workspace: cwd,
        provider: 'pi',
        sessionId: result.externalSessionId!,
        providerTurnId: result.providerTurnId,
        runId,
        userText: prompt,
        evidence,
        timing,
        status: 'completed',
        archiveFingerprint
      })
      expect(prepared).toMatchObject({ status: 'prepared' })
      if (prepared.status !== 'prepared') throw new Error(`unexpected prepare status: ${prepared.status}`)
      await expect(commitManagedRecorderTurn({
        workspace: cwd,
        provider: 'pi',
        sessionId: result.externalSessionId!,
        providerTurnId: result.providerTurnId,
        runId,
        recordId: prepared.recordId,
        userText: prompt,
        evidence,
        timing,
        status: 'completed',
        archiveFingerprint
      })).resolves.toMatchObject({ status: 'committed' })
      await expect(listRecords(join(cwd, '.scry'))).resolves.toEqual([
        expect.objectContaining({
          providerTurnId: 'pi-user-1',
          skills: expect.objectContaining({
            value: [expect.objectContaining({ name: 'rate-workflow', category: 'skill' })]
          })
        })
      ])
      await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
        .resolves.toEqual({ recovered: 0, pending: 0 })
    })
  }, 15_000)

  it('fails closed when an explicit skill is absent from get_commands', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-missing-skill', prompt: '/skill:missing', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).rejects.toThrow('命令目录未证明')
    })
  }, 10_000)

  it('fails closed after prompt acceptance when no authoritative user entry appears', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-no-entry', prompt: 'no-entry', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).rejects.toThrow('prompt 已接受')
    })
  }, 15_000)

  it('uses append order as the cursor and accepts a user descendant through prompt-time compaction', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-compact', prompt: 'with-compact', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      }).promise).resolves.toMatchObject({ providerTurnId: 'pi-user-2' })
    })

    expect(piUserEntryIdAfterBaseline('leaf-before', [
      { type: 'compaction', id: 'compact', parentId: 'leaf-before' },
      { type: 'message', id: 'user-next', parentId: 'compact', message: { role: 'user', content: 'expanded' } }
    ])).toBe('user-next')
    expect(() => piUserEntryIdAfterBaseline('leaf-before', [
      { type: 'message', id: 'user-next', parentId: 'different-leaf', message: { role: 'user' } }
    ])).toThrow('ancestry')
    expect(() => piUserEntryIdAfterBaseline(null, [
      { type: 'message', id: 'user-1', parentId: null, message: { role: 'user' } },
      { type: 'message', id: 'user-2', parentId: 'user-1', message: { role: 'user' } }
    ])).toThrow('多个新增')
  }, 15_000)

  it('cancels the exact managed provisional lifecycle when Pi rejects prompt preflight', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        workspaceId: 'pi-managed-reject-fixture',
        dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const prompt = 'preflight-reject'
      const runId = 'run-managed-preflight-reject'
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId,
        prompt,
        cwd,
        agentProfileId: profile.id,
        attachments: [],
        permissionMode: 'full_access',
        managedRecorder: true,
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(prompt).digest('hex')
        },
        emit: vi.fn()
      }).promise).rejects.toThrow('preflight rejected')
      await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
        .resolves.toEqual({ recovered: 0, pending: 0 })
    })
  }, 15_000)

  it('retains the managed provisional lifecycle when prompt transport outcome is uncertain', async () => {
    await withFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, 'scry.config.json'), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        workspaceId: 'pi-managed-transport-fixture',
        dataDir: '.scry',
        repositories: { mode: 'workspace-only' },
        capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
      }))
      const prompt = 'transport-exit'
      const runId = 'run-managed-transport-exit'
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId,
        prompt,
        cwd,
        agentProfileId: profile.id,
        attachments: [],
        permissionMode: 'full_access',
        managedRecorder: true,
        managedRecorderIdentity: {
          runId,
          promptHash: createHash('sha256').update(prompt).digest('hex')
        },
        emit: vi.fn()
      }).promise).rejects.toThrow()
      await expect(recoverManagedRecorderTurns(cwd, process.env, { provider: 'pi' }))
        .resolves.toEqual({ recovered: 0, pending: 1 })
    })
  }, 10_000)

  it('fails closed when full access was not explicitly selected', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      await expect(adapter.run({
        runId: 'run-1', prompt: 'hello', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'default', emit: vi.fn()
      }).promise).rejects.toThrow('本机完全访问')
    })
  })

  it('does not answer an extension question after the RPC stdin has closed', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let questionAborted = false
      const result = await adapter.run({
        runId: 'run-pending-question', prompt: 'pending-question', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn(),
        requestUserInput: (_question, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            questionAborted = true
            reject(new Error('question aborted'))
          }, { once: true })
        })
      }).promise
      expect(result).toMatchObject({ stopped: false, status: 'completed' })
      expect(questionAborted).toBe(true)
      await new Promise((resolve) => setImmediate(resolve))
    })
  })

  it('does not wait for a redundant final state snapshot after an acknowledged stop', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      let promptStarted!: () => void
      const started = new Promise<void>((resolve) => { promptStarted = resolve })
      const handle = adapter.run({
        runId: 'run-stop-before-final-state', prompt: 'stop-before-final-state', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access',
        emit: (event) => {
          if (event.stage === 'text_delta') promptStarted()
        }
      })
      await started
      handle.interrupt()
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
      expect(existsSync(join(cwd, 'final-state-requested'))).toBe(false)
    })
  }, 10_000)

  it('settles as interrupted when abort has to terminate a stuck launcher', async () => {
    await withFixture(async (profile, cwd) => {
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile })
      const handle = adapter.run({
        runId: 'run-hang', prompt: 'hang', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit: vi.fn()
      })
      // 每轮 run 自己 spawn Pi RPC 子进程：硬杀仅限本 run。
      expect(handle.forceKillScope).toBe('run_scoped')
      setTimeout(() => handle.interrupt(), 50)
      await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
    })
  }, 10_000)
})
