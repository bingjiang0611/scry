import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORDER_VERSION } from '../core/turn-recorder/store'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { verifyCapture } from './verify-capture'
import { parseArgs, runScryCli } from './scry'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'scry-cli-test-'))
  roots.push(created)
  const root = await realpath(created)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'cli-test',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

function captureStdout(): { text: () => string } {
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write)
  return { text: () => output }
}

describe('Scry CLI arguments', () => {
  it('支持等号参数且布尔参数不吞 positional', () => {
    const parsed = parseArgs(['turns', 'summary', '--all', 'session-1', '--workspace=/repo', '--providers=claude,codex'])
    expect(parsed.positionals).toEqual(['turns', 'summary', 'session-1'])
    expect(parsed.flags.get('all')).toBe(true)
    expect(parsed.flags.get('workspace')).toBe('/repo')
    expect(parsed.flags.get('providers')).toBe('claude,codex')
  })

  it('拒绝未知参数和缺失值', () => {
    expect(() => parseArgs(['doctor', '--workspce', '/repo'])).toThrow('unknown option')
    expect(() => parseArgs(['doctor', '--workspace'])).toThrow('missing value')
  })

  it('help 使用 stdout 并成功退出', async () => {
    const stdout = captureStdout()
    await expect(runScryCli(['--help'])).resolves.toBe(0)
    expect(stdout.text()).toContain('Usage:')
  })

  it('--version 不会被空 positional 误判成 help', async () => {
    const stdout = captureStdout()
    await expect(runScryCli(['--version'])).resolves.toBe(0)
    expect(stdout.text()).toBe(`${RECORDER_VERSION}\n`)
  })
})

describe('Scry CLI health and lookup contracts', () => {
  it('历史累计错误不让当前 doctor 永久 degraded', async () => {
    const root = await workspace()
    await mkdir(join(root, '.scry'), { recursive: true })
    await writeFile(join(root, '.scry', 'health.json'), JSON.stringify({
      schemaVersion: 1,
      droppedEvents: 3,
      orphanEvents: 2,
      pendingCount: 0,
      oldestPendingAgeMs: 0,
      recoveredRecords: 0,
      lastSuccessAt: new Date().toISOString()
    }))
    const stdout = captureStdout()

    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ healthy: true })
  })

  it('记录不存在时输出可解析结果并退出 1', async () => {
    const root = await workspace()
    const stdout = captureStdout()

    await expect(runScryCli(['turns', 'show', '999', '--workspace', root])).resolves.toBe(1)
    expect(JSON.parse(stdout.text())).toEqual({ found: false, selector: '999' })
  })
})

describe('scry commit-hook', () => {
  async function hookWorkspace(): Promise<{ root: string; grantDir: string }> {
    const root = await workspace()
    const grantDir = join(root, 'grants')
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, unknown>
    config.commitHook = { entry: 'uploader.sh', files: ['uploader.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    process.env.SCRY_GRANT_DIR = grantDir
    return { root, grantDir }
  }

  afterEach(() => {
    delete process.env.SCRY_GRANT_DIR
  })

  it('未配置 commitHook 时 status 退出 0 并显式说明 backlog 不可观测', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
    const payload = JSON.parse(stdout.text()) as Record<string, any>
    expect(payload.configured).toBe(false)
    expect(payload.activation.status).toBe('not-configured')
    expect(payload.notifications.notifyBacklog).toBeNull()
    expect(payload.notifications.backlogEvidence).toContain('unavailable')
  })

  it('已配置未授权时 status 退出 3，trust 不带 --yes 只打印待授权 bundle', async () => {
    const { root, grantDir } = await hookWorkspace()
    const statusOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(statusOut.text()) as Record<string, any>).activation.status).toBe('configured-not-trusted')

    vi.restoreAllMocks()
    const trustOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--workspace', root])).resolves.toBe(3)
    const payload = JSON.parse(trustOut.text()) as Record<string, any>
    expect(payload.status).toBe('approval-required')
    expect(payload.files).toHaveLength(1)
    expect(payload.warning).toContain('read every record')
    await expect(access(join(grantDir))).rejects.toThrow()
  })

  it('--yes 授权后 status 退出 0，篡改后退出 4', async () => {
    const { root } = await hookWorkspace()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)

    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\necho tampered\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(4)
    expect((JSON.parse(stdout.text()) as Record<string, any>).activation.status).toBe('fingerprint-mismatch')

    await expect(runScryCli(['commit-hook', 'revoke', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(3)
  })

  it('entry 缺少可执行位时退出 5', async () => {
    const { root } = await hookWorkspace()
    await chmod(join(root, 'uploader.sh'), 0o644)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(5)
    expect((JSON.parse(stdout.text()) as Record<string, any>).detail).toContain('executable')
  })
})

describe('scry status', () => {
  async function hookedWorkspace(): Promise<string> {
    const root = await workspace()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: "SCRY_HANDLER_ID=turn-recorder-v1 sh -c 'exec ./.scry/provider-hook.sh claude Stop'" }] }]
        }
      })
    )
    return root
  }

  it('recorder 未启用时退出 2 并给出原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-cli-nostate-'))
    roots.push(root)
    const stdout = captureStdout()
    await expect(runScryCli(['status', '--workspace', root])).resolves.toBe(2)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.recorder).toMatchObject({ enabled: false, reason: 'missing_config' })
    expect(report.commitHook).toBeNull()
  })

  it('已配置但没有 hook 事件时退出 3，且 trust 一律 unknown', async () => {
    const root = await hookedWorkspace()
    const stdout = captureStdout()
    await expect(runScryCli(['status', '--workspace', root])).resolves.toBe(3)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    const claude = report.providers.find((row: any) => row.provider === 'claude')
    expect(claude).toMatchObject({ configured: 'workspace', state: 'configured-no-events', trusted: 'unknown' })
    expect(report.trustEvidence).toContain('does not expose hook trust state')
    expect(report.providers.every((row: any) => row.trusted === 'unknown')).toBe(true)
    expect(report.recorder.openTurnsPending).toBe(0)
  })

  it('采到一轮后进入 capturing，并区分 openTurnsPending 与 notifyBacklog', async () => {
    const root = await hookedWorkspace()
    const payload = { session_id: 'status-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: 'implement' }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' }
    })
    const stdout = captureStdout()
    await expect(runScryCli(['status', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    const claude = report.providers.find((row: any) => row.provider === 'claude')
    expect(claude.state).toBe('capturing')
    expect(claude.hookSeen.events).toBeGreaterThan(0)
    expect(claude.recordSeen.sequence).toBe(1)
    expect(report.commitHook).toMatchObject({
      configured: false,
      activation: 'not-configured',
      notifyBacklog: null
    })
    expect(report.commitHook.backlogEvidence).toContain('unavailable')
  })
})

describe('scry recorder notify-drain', () => {
  it('未激活 commit hook 时不投递，退出码区分未配置与待授权', async () => {
    const root = await workspace()
    await expect(runScryCli(['recorder', 'notify-drain', '--workspace', root])).resolves.toBe(0)

    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, unknown>
    config.commitHook = { entry: 'uploader.sh', files: ['uploader.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    process.env.SCRY_GRANT_DIR = join(root, 'grants')
    try {
      const stdout = captureStdout()
      await expect(runScryCli(['recorder', 'notify-drain', '--workspace', root])).resolves.toBe(3)
      expect((JSON.parse(stdout.text()) as Record<string, any>).status).toBe('not-activated')
    } finally {
      delete process.env.SCRY_GRANT_DIR
    }
  })
})

describe('scry verify-capture', () => {
  it('缺少配置时报 missing_config 并退出 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-cli-verify-'))
    roots.push(root)
    const stdout = captureStdout()
    await expect(runScryCli(['verify-capture', '--workspace', root, '--timeout', '0'])).resolves.toBe(2)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result).toMatchObject({ reason: 'missing_config', record: null })
    expect(result.remediation).toContain('scry init')
  })

  it('被 sentinel 关闭时报 disabled 而不是 no_hook_event', async () => {
    const root = await workspace()
    await writeFile(join(root, '.scry-disabled'), '')
    const stdout = captureStdout()
    await expect(runScryCli(['verify-capture', '--workspace', root, '--timeout', '0'])).resolves.toBe(2)
    expect((JSON.parse(stdout.text()) as Record<string, any>).reason).toBe('disabled')
  })

  it('没有任何 hook 事件时报 no_hook_event 并退出 3', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['verify-capture', '--workspace', root, '--timeout', '0'])).resolves.toBe(3)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result.reason).toBe('no_hook_event')
    expect(result.evidence.hookEvents).toEqual({})
    expect(result.remediation).toContain('/hooks')
  })

  it('事件到达但轮次未收敛时报 pending_open_turn', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'verify-open', timestamp: '2026-07-19T12:00:00.000Z', prompt: 'work' }
    })
    const stdout = captureStdout()
    await expect(runScryCli(['verify-capture', '--workspace', root, '--timeout', '0'])).resolves.toBe(3)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result.reason).toBe('pending_open_turn')
    expect(result.evidence.hookEventsEverSeen.claude.events).toBeGreaterThan(0)
    // openTurnInFlight means "a turn is running"; openTurnsPending means "a turn needs
    // recovery". They are different signals and must not be conflated.
    expect(result.evidence.openTurnInFlight).toBe(true)
    expect(result.evidence.openTurnsPending).toBe(0)
    expect(result.detail).toContain('still in flight')
  })

  it('采到新轮次时报 ok，并逐段暴露证据状态', async () => {
    const root = await workspace()
    const payload = { session_id: 'verify-ok', timestamp: '2026-07-19T12:00:00.000Z', prompt: 'work' }
    const capture = verifyCapture(root, { timeoutMs: 15_000 })
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' }
    })
    const result = await capture
    expect(result.reason).toBe('ok')
    expect(result.record).toMatchObject({ sequence: 1, provider: 'claude', status: 'completed' })
    expect(result.record?.evidence.user).toBe('available/exact')
    // A green result must still surface sections the provider cannot supply.
    expect(Object.values(result.record?.evidence ?? {}).some((value) => value.startsWith('unavailable'))).toBe(true)
  })

  it('已有历史记录时只承认新提交的轮次', async () => {
    const root = await workspace()
    const first = { session_id: 'verify-old', timestamp: '2026-07-19T12:00:00.000Z', prompt: 'old' }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: first })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: { ...first, timestamp: '2026-07-19T12:00:01.000Z' } })

    const stdout = captureStdout()
    await expect(runScryCli(['verify-capture', '--workspace', root, '--timeout', '0'])).resolves.toBe(3)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    // A previously committed record must never be reported as this run's proof of capture.
    expect(result.reason).toBe('no_hook_event')
    expect(result.record).toBeNull()
    expect(result.detail).toContain('previously seen from claude')
    expect(result.evidence.hookEventsEverSeen.claude.events).toBeGreaterThan(0)
    expect(result.evidence.hookEvents).toEqual({})
  })
})

describe('scry integrations diff/uninstall', () => {
  const managed = "SCRY_HANDLER_ID=turn-recorder-v1 sh -c 'exec ./.scry/provider-hook.sh claude Stop'"
  const foreign = 'echo user-hook'

  async function claudeWorkspace(hooks: Record<string, unknown>): Promise<string> {
    const root = await workspace()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), JSON.stringify({ hooks }, null, 2))
    await mkdir(join(root, '.scry'), { recursive: true })
    await writeFile(join(root, '.scry', 'provider-hook.sh'), '#!/bin/sh\nexport SCRY_HANDLER_ID=turn-recorder-v1\n')
    await writeFile(join(root, '.scry', 'cli-path'), '/usr/local/bin/scry\n')
    return root
  }

  it('diff 零副作用，并按 handler id 报告托管条目与外部条目', async () => {
    const root = await claudeWorkspace({
      Stop: [{ hooks: [{ type: 'command', command: managed }, { type: 'command', command: foreign }] }]
    })
    const before = await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'diff', '--workspace', root])).resolves.toBe(3)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    const claude = result.providers.find((row: any) => row.provider === 'claude')
    expect(claude).toMatchObject({ present: true, managedEvents: ['Stop'], foreignEntries: 1 })
    expect(claude.missingEvents).toContain('UserPromptSubmit')
    expect(result.pi.scope).toBe('user-global')
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe(before)
  })

  it('diff 检出命令形状漂移造成的重复托管条目', async () => {
    const root = await claudeWorkspace({
      Stop: [
        { hooks: [{ type: 'command', command: managed }] },
        { hooks: [{ type: 'command', command: `${managed} --legacy` }] }
      ]
    })
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'diff', '--workspace', root])).resolves.toBe(3)
    const claude = (JSON.parse(stdout.text()) as Record<string, any>).providers.find((row: any) => row.provider === 'claude')
    expect(claude.duplicateEvents).toEqual(['Stop'])
  })

  it('uninstall 不带 --yes 只打印计划', async () => {
    const root = await claudeWorkspace({ Stop: [{ hooks: [{ type: 'command', command: managed }] }] })
    const before = await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'uninstall', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(stdout.text()) as Record<string, any>).status).toBe('approval-required')
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe(before)
    await expect(access(join(root, '.scry', 'provider-hook.sh'))).resolves.toBeUndefined()
  })

  it('uninstall --yes 只删托管条目，保留用户 hook、records 与配置', async () => {
    const root = await claudeWorkspace({
      Stop: [{ hooks: [{ type: 'command', command: managed }, { type: 'command', command: foreign }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: managed }] }]
    })
    await mkdir(join(root, '.scry', 'records'), { recursive: true })
    await writeFile(join(root, '.scry', 'records', 'keep.json'), '{}')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'uninstall', '--yes', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>

    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')) as Record<string, any>
    expect(settings.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: foreign }])
    // A group that only held our entry is dropped, and an empty event key is removed.
    expect(settings.hooks.PreToolUse).toBeUndefined()
    await expect(access(join(root, '.scry', 'provider-hook.sh'))).rejects.toThrow()
    await expect(access(join(root, '.scry', 'cli-path'))).rejects.toThrow()
    await expect(access(join(root, '.scry', 'records', 'keep.json'))).resolves.toBeUndefined()
    await expect(access(join(root, 'scry.config.json'))).resolves.toBeUndefined()
    expect(result.retained.map((item: any) => item.path)).toContain(join(root, '.scry', 'records'))
    expect(result.rewritten).toContain(join(root, '.claude', 'settings.local.json'))
  })

  it('坏 JSON 与非托管 OpenCode 插件被跳过而不是破坏', async () => {
    const root = await workspace()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), '{ not json')
    await mkdir(join(root, '.opencode', 'plugins'), { recursive: true })
    await writeFile(join(root, '.opencode', 'plugins', 'scry-recorder.js'), '// hand written\n')
    const stdout = captureStdout()
    await expect(runScryCli(['integrations', 'uninstall', '--yes', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result.skipped.map((item: any) => item.path)).toEqual([
      join(root, '.claude', 'settings.local.json'),
      join(root, '.opencode', 'plugins', 'scry-recorder.js')
    ])
    expect(await readFile(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe('{ not json')
    await expect(access(join(root, '.opencode', 'plugins', 'scry-recorder.js'))).resolves.toBeUndefined()
  })
})

describe('scry doctor schema and exit codes', () => {
  it('健康时输出稳定 schema 并退出 0', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ schemaVersion: 1, status: 'healthy', healthy: true, enabled: true })
    expect(report.checks.map((check: any) => check.id)).toEqual([
      'recorder.enabled', 'store.integrity', 'turns.pending', 'recorder.lastError'
    ])
    expect(report.checks.every((check: any) => check.status === 'pass')).toBe(true)
    expect(report.recorderVersion).toBe(RECORDER_VERSION)
  })

  it('缺少配置退出 3，sentinel 关闭退出 2', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'scry-cli-doctor-'))
    roots.push(missing)
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', missing])).resolves.toBe(3)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ schemaVersion: 1, status: 'unavailable', enabled: false, reason: 'missing_config' })
    expect(report.checks[0].remediation).toContain('scry init')

    const disabled = await workspace()
    await writeFile(join(disabled, '.scry-disabled'), '')
    await expect(runScryCli(['doctor', '--workspace', disabled])).resolves.toBe(2)
  })

  it('store 损坏退出 4', async () => {
    const degraded = await workspace()
    for (const session of ['doctor-a', 'doctor-b']) {
      await handleRecorderHook({
        provider: 'claude',
        event: 'UserPromptSubmit',
        workspace: degraded,
        payload: { session_id: session, timestamp: '2026-07-19T12:00:00.000Z', prompt: 'p' }
      })
      await handleRecorderHook({
        provider: 'claude',
        event: 'Stop',
        workspace: degraded,
        payload: { session_id: session, timestamp: '2026-07-19T12:00:01.000Z' }
      })
    }
    const records = join(degraded, '.scry', 'records')
    const [name] = (await readdir(records)).sort()
    // Removing a committed record leaves a sequence gap: doctor must report corrupt, not healthy.
    await rm(join(records, name))
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', degraded])).resolves.toBe(4)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.status).toBe('corrupt')
    const integrity = report.checks.find((check: any) => check.id === 'store.integrity')
    expect(integrity.status).toBe('fail')
    expect(integrity.remediation).toContain('do not delete individual record files')
  })
})

describe('scry turns project', () => {
  const SECRET_PROMPT = 'DO-NOT-UPLOAD-THIS-PROMPT-TEXT'

  async function recordedWorkspace(): Promise<string> {
    const root = await workspace()
    const payload = { session_id: 'proj-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: SECRET_PROMPT }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({
      provider: 'claude',
      event: 'PreToolUse:Bash',
      workspace: root,
      payload: {
        ...payload,
        tool_name: 'Bash',
        tool_use_id: 'proj-1-t1',
        tool_input: { command: 'sudo rm -rf /secret/path/inside/repo' }
      }
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'PostToolUse:Bash',
      workspace: root,
      payload: { ...payload, tool_name: 'Bash', tool_use_id: 'proj-1-t1', tool_response: 'SECRET-TOOL-OUTPUT' }
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { ...payload, timestamp: '2026-07-19T12:00:02.000Z' }
    })
    return root
  }

  it('投影只输出白名单字段，且不泄露 prompt/工具输入输出/路径', async () => {
    const root = await recordedWorkspace()
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'project', '1', '--policy', 'team-metadata@1', '--workspace', root])).resolves.toBe(0)
    const text = stdout.text()
    const projected = JSON.parse(text) as Record<string, any>

    expect(Object.keys(projected).sort()).toEqual([
      'compactions', 'completedAt', 'counts', 'dangerousOperations', 'diffStats', 'durationMs', 'errors',
      'evidence', 'interventions', 'modelTiming', 'policyVersion', 'provider', 'recordId', 'recorderVersion',
      'schemaVersion', 'sequence', 'sessionId', 'startedAt', 'status', 'turnIndex', 'usage', 'workspaceIdHash'
    ])
    expect(text).not.toContain(SECRET_PROMPT)
    expect(text).not.toContain('SECRET-TOOL-OUTPUT')
    expect(text).not.toContain('/secret/path/inside/repo')
    // The workspace path and raw workspace id must never leave the machine.
    expect(text).not.toContain(root)
    expect(projected.workspaceIdHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(projected.policyVersion).toBe('team-metadata@1')
  })

  it('危险操作只带分类，不带命令原文；计数与证据一致', async () => {
    const root = await recordedWorkspace()
    const stdout = captureStdout()
    await runScryCli(['turns', 'project', '1', '--workspace', root])
    const projected = JSON.parse(stdout.text()) as Record<string, any>

    expect(projected.counts.tools).toBe(1)
    expect(projected.dangerousOperations.length).toBeGreaterThan(0)
    for (const danger of projected.dangerousOperations) {
      expect(Object.keys(danger).sort()).toEqual(['level', 'reason', 'tool'])
      expect(danger.reason).not.toContain('rm -rf')
      expect(danger.reason).not.toContain('/secret')
    }
    expect(projected.evidence.tools).toBe('available/exact')
  })

  it('不可观测的数值输出 null 而不是 0', async () => {
    const root = await recordedWorkspace()
    const stdout = captureStdout()
    await runScryCli(['turns', 'project', '1', '--workspace', root])
    const projected = JSON.parse(stdout.text()) as Record<string, any>

    // Claude lifecycle hooks expose no usage, so cost/tokens are unavailable — not zero.
    expect(projected.usage).toBeNull()
    expect(projected.evidence.usage.startsWith('unavailable')).toBe(true)
    expect(projected.diffStats).toBeNull()
    expect(projected.evidence.diff.startsWith('disabled') || projected.evidence.diff.startsWith('unavailable')).toBe(true)
  })

  it('未知 policy 报错，记录不存在退出 1', async () => {
    const root = await recordedWorkspace()
    await expect(runScryCli(['turns', 'project', '1', '--policy', 'team-full@9', '--workspace', root]))
      .rejects.toThrow(/--policy must be one of/)
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'project', '999', '--workspace', root])).resolves.toBe(1)
    expect((JSON.parse(stdout.text()) as Record<string, any>).found).toBe(false)
  })
})

describe('scry capture', () => {
  it('show 输出解析后的生效配置，并说明它不覆盖工具入参与 diff', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['capture', 'show', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result.effective).toMatchObject({ prompt: true, assistant: true, toolOutput: 'summary', hooks: true })
    expect(result.note).toContain('tool inputs')
  })

  it('显式关闭正文后 record 以 disabled 解释缺失，无需额外 policy 字段', async () => {
    const root = await workspace()
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, any>
    config.capture = { prompt: false, assistant: false, toolOutput: 'none' }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    const SECRET = 'SHOULD-NOT-BE-STORED'
    const payload = { session_id: 'cap-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: SECRET }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' }
    })
    const [file] = await readdir(join(root, '.scry', 'records'))
    const stored = await readFile(join(root, '.scry', 'records', file), 'utf8')
    expect(stored).not.toContain(SECRET)
    const record = JSON.parse(stored) as Record<string, any>
    // `disabled` + reason already records that config, not the provider, withheld it.
    expect(record.user.status).toBe('disabled')
    expect(record.user.omissionReason).toContain('config')
    expect(record.capturePolicy).toBeUndefined()
  })
})

describe('scry records archive', () => {
  async function withTurns(count: number): Promise<string> {
    const root = await workspace()
    for (let index = 1; index <= count; index++) {
      const payload = { session_id: `arch-${index}`, timestamp: '2026-07-19T12:00:00.000Z', prompt: 'p' }
      await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
      await handleRecorderHook({
        provider: 'claude',
        event: 'Stop',
        workspace: root,
        payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' }
      })
    }
    return root
  }

  it('归档搬移前缀并记录 floor，store 仍然 ok', async () => {
    const root = await withTurns(3)
    const out = join(root, 'archived')
    const stdout = captureStdout()
    // Records are stamped with the payload timestamp, so a future cutoff selects all of them.
    await expect(runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--out', out, '--yes', '--workspace', root])).resolves.toBe(0)
    const result = JSON.parse(stdout.text()) as Record<string, any>
    expect(result).toMatchObject({ status: 'done', archived: 3, archivedThrough: 3, remaining: 0, storeOk: true })
    expect((await readdir(join(out, 'records'))).length).toBe(3)
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as Record<string, any>
    expect(manifest.records[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('归档后新轮次接着 floor 继续，doctor 不报损坏', async () => {
    const root = await withTurns(2)
    await runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--yes', '--workspace', root])
    const payload = { session_id: 'arch-next', timestamp: '2026-07-19T13:00:00.000Z', prompt: 'p' }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: { ...payload, timestamp: '2026-07-19T13:00:01.000Z' } })

    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.status).toBe('healthy')
    expect(report.store).toMatchObject({ ok: true, records: 1, archivedThrough: 2 })
  })

  it('不带 --yes 只打印计划；无候选时退出 3', async () => {
    const root = await withTurns(1)
    const plan = captureStdout()
    await expect(runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(plan.text()) as Record<string, any>).status).toBe('approval-required')
    expect((await readdir(join(root, '.scry', 'records'))).length).toBe(1)

    vi.restoreAllMocks()
    const empty = captureStdout()
    await expect(runScryCli(['records', 'archive', '--before', '2000-01-01T00:00:00.000Z', '--workspace', root])).resolves.toBe(3)
    expect((JSON.parse(empty.text()) as Record<string, any>).status).toBe('nothing-to-archive')
  })

  it('配置了 commit hook 但尚未投递时拒绝归档', async () => {
    const root = await withTurns(2)
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, any>
    config.commitHook = { entry: 'uploader.sh', files: ['uploader.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    process.env.SCRY_GRANT_DIR = join(root, 'grants')
    try {
      const stdout = captureStdout()
      await expect(runScryCli(['records', 'archive', '--before', '2030-01-01T00:00:00.000Z', '--yes', '--workspace', root])).resolves.toBe(5)
      const result = JSON.parse(stdout.text()) as Record<string, any>
      expect(result).toMatchObject({ status: 'refused', reason: 'undelivered-records' })
      expect(result.remediation).toContain('notify-drain')
      expect((await readdir(join(root, '.scry', 'records'))).length).toBe(2)
    } finally {
      delete process.env.SCRY_GRANT_DIR
    }
  })
})

describe('scry support-bundle', () => {
  it('只输出脱敏诊断，不含 record 正文、路径与 env 值', async () => {
    const root = await workspace()
    const SECRET = 'BUNDLE-MUST-NOT-CONTAIN-THIS'
    const payload = { session_id: 'bundle-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: SECRET }
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: { ...payload, timestamp: '2026-07-19T12:00:01.000Z' } })

    const stdout = captureStdout()
    await expect(runScryCli(['support-bundle', 'create', '--workspace', root])).resolves.toBe(0)
    const text = stdout.text()
    const bundle = JSON.parse(text) as Record<string, any>

    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(root)
    expect(bundle.workspace.idHash).toMatch(/^sha256:[a-f0-9]{32}$/)
    expect(bundle.workspace.configFingerprint).toMatch(/^sha256:[a-f0-9]{32}$/)
    expect(bundle.workspace.capture).toMatchObject({ prompt: true, assistant: true, toolOutput: 'summary' })
    expect(bundle.recorder).toMatchObject({ enabled: true })
    expect(bundle.recorder.store).toMatchObject({ ok: true, records: 1 })
    expect(bundle.omitted.length).toBeGreaterThan(0)
  })

  it('写入文件时权限 0600，且 recorder 未启用退出 2', async () => {
    const root = await workspace()
    const out = join(root, 'bundle.json')
    await expect(runScryCli(['support-bundle', 'create', '--out', out, '--workspace', root])).resolves.toBe(0)
    expect((await stat(out)).mode & 0o777).toBe(0o600)

    const bare = await mkdtemp(join(tmpdir(), 'scry-cli-bundle-'))
    roots.push(bare)
    const stdout = captureStdout()
    await expect(runScryCli(['support-bundle', 'create', '--workspace', bare])).resolves.toBe(2)
    expect((JSON.parse(stdout.text()) as Record<string, any>).recorder).toMatchObject({ enabled: false, reason: 'missing_config' })
  })
})
