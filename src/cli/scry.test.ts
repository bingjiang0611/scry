import { execFileSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECORDER_VERSION, listRecords, stableHash, verifyStore } from '../core/turn-recorder/store'
import { summarizeTurnRecords } from '../core/turn-recorder/turns-summary'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { parseArgs, runScryCli } from './scry'
import { initWorkspace, integrationsRepair } from './workspace-init'
import { collectSupportBundle } from './support-bundle'

const recordReads = vi.hoisted(() => new Map<string, number>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = args[0]
      if (typeof path === 'string' && recordReads.has(path)) recordReads.set(path, recordReads.get(path)! + 1)
      return actual.readFile(...args)
    }
  }
})

const roots: string[] = []

afterEach(async () => {
  recordReads.clear()
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
  it.each(['status', 'doctor', 'bundle'])('hook-skip %s reports retained counts and the latest timestamp', async (command) => {
    const root = await workspace()
    await mkdir(join(root, '.scry/logs'), { recursive: true })
    await writeFile(join(root, '.scry/logs/hook-skip.log'),
      '2026-10-24T12:00:00Z\tcodex\tStop\tcli_not_executable\t0\n2026-10-24T12:00:01Z\tqoder\tStop\tcli_failed\t17\n')
    const stdout = captureStdout()
    let report: unknown
    if (command === 'bundle') report = await collectSupportBundle(root)
    else {
      const args = command === 'doctor' ? ['doctor'] : ['recorder', 'status']
      expect(await runScryCli([...args, '--workspace', root])).toBe(command === 'doctor' ? 5 : 0)
      report = JSON.parse(stdout.text())
    }
    expect(report).toMatchObject({ hookSkips: { count: 2, lastAt: '2026-10-24T12:00:01Z', scope: 'retained_log_window' } })
    if (command === 'doctor') expect(report).toMatchObject({ status: 'error', healthy: false,
      checks: expect.arrayContaining([expect.objectContaining({ id: 'hook.skips', status: 'fail' })]) })
  })

  it('hook-skip invalid_config leaves diagnostics but explicit disablement stays quiet', async () => {
    const root = await workspace()
    await writeFile(join(root, 'scry.config.json'), '{invalid')
    await expect(handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root,
      payload: { session_id: 'bad-config' }, env: {} })).resolves.toMatchObject({ status: 'disabled', reason: 'invalid_config' })
    expect(await readFile(join(root, '.scry/logs/hook-skip.log'), 'utf8')).toContain('\tcodex\tStop\tinvalid_config\t')
    const stdout = captureStdout()
    expect(await runScryCli(['doctor', '--workspace', root])).toBe(3)
    expect(JSON.parse(stdout.text())).toMatchObject({ status: 'error', hookSkips: { count: 1 } })
    const before = await readFile(join(root, '.scry/logs/hook-skip.log'), 'utf8')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root,
      payload: { session_id: 'disabled' }, env: { SCRY_RECORDER_ENABLED: '0' } })
    expect(await readFile(join(root, '.scry/logs/hook-skip.log'), 'utf8')).toBe(before)
  })

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

  it('按字节游标分页读取记录引用的完整原文', async () => {
    const root = await workspace()
    const configPath = join(root, 'scry.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    delete config.capture.toolOutput
    await writeFile(configPath, JSON.stringify(config))
    const base = { provider: 'claude' as const, workspace: root }
    const event = (extra: Record<string, unknown>) => ({ session_id: 'content-page', timestamp: new Date().toISOString(), ...extra })
    const secret = 'CLI_PAGE_SECRET'
    const output = `${'中😀'.repeat(5_000)}\nAuthorization: Bearer ${secret}\nTAIL`
    const assistant = `${'回答🧠'.repeat(5_000)}\nASSISTANT-TAIL`
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: event({ prompt: 'capture' }) })
    await handleRecorderHook({ ...base, event: 'PreToolUse:Bash', payload: event({ tool_name: 'Bash', tool_use_id: 'call', tool_input: { command: 'generate' } }) })
    await handleRecorderHook({ ...base, event: 'PostToolUse:Bash', payload: event({ tool_name: 'Bash', tool_use_id: 'call', tool_response: output }) })
    await handleRecorderHook({ ...base, event: 'Stop', payload: event({ assistant_response: assistant }) })

    const bytes: Buffer[] = []
    let offset = 0
    do {
      const stdout = captureStdout()
      await expect(runScryCli([
        'turns', 'content', '1', 'tools', '0', 'output', '--workspace', root,
        '--offset', String(offset), '--limit', '4097'
      ])).resolves.toBe(0)
      const page = JSON.parse(stdout.text()) as { dataBase64: string; nextOffset: number; hasMore: boolean }
      bytes.push(Buffer.from(page.dataBase64, 'base64'))
      offset = page.nextOffset
      vi.restoreAllMocks()
      if (!page.hasMore) break
    } while (true)
    const complete = Buffer.concat(bytes).toString('utf8')
    expect(complete).toContain('TAIL')
    expect(complete).toBe(output)
    expect(complete).toContain(secret)

    const modelStdout = captureStdout()
    await expect(runScryCli([
      'turns', 'content', '1', 'modelSegments', '0', '0', '--workspace', root, '--limit', '262144'
    ])).resolves.toBe(0)
    const modelPage = JSON.parse(modelStdout.text()) as { path: string; dataBase64: string; hasMore: boolean }
    expect(modelPage.path).toBe('modelSegments.0.0')
    expect(modelPage.hasMore).toBe(false)
    expect(Buffer.from(modelPage.dataBase64, 'base64').toString('utf8')).toBe(assistant)
    vi.restoreAllMocks()

    const bundle = join(root, 'complete-export')
    const exportStdout = captureStdout()
    await expect(runScryCli(['turns', 'export-bundle', bundle, '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(exportStdout.text())).toMatchObject({ target: bundle, records: 1 })
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ schemaVersion: 1, kind: 'scry-recorder-export', records: [expect.objectContaining({ sequence: 1 })] })
    const [bundledRecord] = await listRecords(bundle)
    await expect(readRecorderContent(bundle, bundledRecord.tools.value![0].outputContent!.contentRef!)).resolves.toBe(output)
    await expect(readRecorderContent(bundle, bundledRecord.modelSegments!.value![0].contentRefs![0])).resolves.toBe(assistant)
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

  it('status 和不带 --yes 的 trust 都会自动授权有效 bundle', async () => {
    const { root, grantDir } = await hookWorkspace()
    const statusOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
    expect((JSON.parse(statusOut.text()) as Record<string, any>).activation.status).toBe('trusted')
    await expect(access(join(grantDir))).resolves.toBeUndefined()

    vi.restoreAllMocks()
    const trustOut = captureStdout()
    await expect(runScryCli(['commit-hook', 'trust', '--workspace', root])).resolves.toBe(0)
    const payload = JSON.parse(trustOut.text()) as Record<string, any>
    expect(payload).toMatchObject({ status: 'trusted', source: 'auto' })
  })

  it('兼容 --yes，且脚本变化后自动更新指纹', async () => {
    const { root } = await hookWorkspace()
    await expect(runScryCli(['commit-hook', 'trust', '--yes', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)

    await writeFile(join(root, 'uploader.sh'), '#!/bin/sh\necho tampered\nexit 0\n')
    await chmod(join(root, 'uploader.sh'), 0o700)
    const stdout = captureStdout()
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
    expect((JSON.parse(stdout.text()) as Record<string, any>).activation.status).toBe('trusted')

    await expect(runScryCli(['commit-hook', 'revoke', '--workspace', root])).resolves.toBe(0)
    await expect(runScryCli(['commit-hook', 'status', '--workspace', root])).resolves.toBe(0)
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
  it('未配置时不投递，配置有效 hook 后自动激活', async () => {
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
      await expect(runScryCli(['recorder', 'notify-drain', '--workspace', root])).resolves.toBe(0)
      expect((JSON.parse(stdout.text()) as Record<string, any>).activation).toBe('trusted')
    } finally {
      delete process.env.SCRY_GRANT_DIR
    }
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

/** `scry init` refuses anything that is not a Git project root. */
async function gitWorkspace(): Promise<string> {
  const root = await workspace()
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  return root
}

describe('scry doctor schema and exit codes', () => {
  it('健康时输出稳定 schema 并退出 0', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ schemaVersion: 1, status: 'healthy', healthy: true, enabled: true })
    expect(report.checks.map((check: any) => check.id)).toEqual([
      'recorder.enabled', 'store.integrity', 'turns.pending', 'hook.script', 'turns.stale', 'recorder.version', 'recorder.lastError'
    ])
    expect(report.checks.every((check: any) => check.status === 'pass')).toBe(true)
    expect(report.recorderVersion).toBe(RECORDER_VERSION)
  })

  it('升级后遗留的旧 hook 脚本被 doctor 报 warn，repair 后回到 pass', async () => {
    const root = await gitWorkspace()
    await initWorkspace({ workspace: root, providers: 'claude', cliPath: process.execPath })
    const script = join(root, '.scry', 'provider-hook.sh')
    const current = await readFile(script, 'utf8')

    const fresh = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(fresh.text()).hookScript).toBe('current')

    // 模拟旧版本写下的脚本：受管标记还在，内容已经不是这个 CLI 会写的了。
    await writeFile(script, current.replace('#!/bin/sh', '#!/bin/sh\n# 旧版本残留'), { mode: 0o700 })
    // 旧脚本仍能正确采集，只是拿不到新版本的快路径：warn 但不改退出码，与 recorder.version 一致。
    const stale = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stale.text()) as Record<string, any>
    expect(report).toMatchObject({ status: 'healthy', hookScript: 'outdated' })
    expect(report.checks.find((c: any) => c.id === 'hook.script')).toMatchObject({
      status: 'warn', remediation: 'run `scry integrations repair --yes`'
    })
    const diff = captureStdout()
    await runScryCli(['integrations', 'diff', '--workspace', root])
    expect(JSON.parse(diff.text()).artifacts.find((a: any) => a.kind === 'hook-script')).toMatchObject({ status: 'outdated' })

    await integrationsRepair({ workspace: root, cliPath: process.execPath })
    const repaired = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(repaired.text()).hookScript).toBe('current')
  })

  it('自建（非受管）hook 脚本不被 doctor 判为过期', async () => {
    const root = await gitWorkspace()
    await initWorkspace({ workspace: root, providers: 'claude', cliPath: process.execPath })
    await writeFile(join(root, '.scry', 'provider-hook.sh'), '#!/bin/sh\n# 团队自建桥接\nexit 0\n', { mode: 0o700 })
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.hookScript).toBe('unmanaged')
    expect(report.checks.find((c: any) => c.id === 'hook.script')).toMatchObject({ status: 'pass' })
  })

  it('记录由另一份安装写入时只 warn，不改变退出码', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: { session_id: 'ver-1', timestamp: '2026-07-19T12:00:00.000Z', prompt: 'x' }
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: { session_id: 'ver-1', timestamp: '2026-07-19T12:00:01.000Z' }
    })
    // 模拟另一份更老的安装写下的记录。
    const [name] = await readdir(join(root, '.scry', 'records'))
    const file = join(root, '.scry', 'records', name)
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>
    await writeFile(file, JSON.stringify({ ...record, recorderVersion: '0.1.0' }))

    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    const check = report.checks.find((c: any) => c.id === 'recorder.version')
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('0.1.0')
    expect(check.remediation).toContain('SCRY_CLI_PATH')
    expect(report.recorderVersions).toMatchObject({ lastRecord: '0.1.0' })
    expect(report.status).toBe('healthy')
  })

  it('静默 open 轮次报诊断警告，但不引导用户伪造中断', async () => {
    const root = await workspace()
    // 三天前开始、没有 transcript：终态仍未知。
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: {
        session_id: 'stale-1',
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(),
        prompt: '开了就没结束'
      }
    })
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(5)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report).toMatchObject({ status: 'degraded', healthy: false })
    const stale = report.checks.find((check: any) => check.id === 'turns.stale')
    expect(stale.status).toBe('warn')
    expect(stale.remediation).toContain('terminal evidence')
    expect(stale.detail).toContain('termination unconfirmed')
    expect(report.staleOpenTurns).toMatchObject([{ provider: 'claude', sessionId: 'stale-1' }])
    // pendingCount 只统计 managed/closing/quarantined，孤儿轮次不在其中，所以必须单独报。
    expect(report.health.pendingCount).toBe(0)
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

describe('capture 配置的生效值', () => {
  it('doctor 输出解析后的采集配置，包含配置省略的默认值', async () => {
    const root = await workspace()
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, any>
    config.capture = { diff: false }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    const stdout = captureStdout()
    await expect(runScryCli(['doctor', '--workspace', root])).resolves.toBe(0)
    const report = JSON.parse(stdout.text()) as Record<string, any>
    expect(report.capture).toMatchObject({ prompt: true, assistant: true, toolOutput: 'full', toolContentFieldBytes: 8192, toolContentTurnBytes: 131072, diff: false, hooks: true })
  })

  it('显式关闭正文后 record 以 disabled 解释缺失，而不是记成空', async () => {
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
    expect(record.user.status).toBe('disabled')
    expect(record.user.omissionReason).toContain('config')
  })
})

describe('scry records archive and maintenance', () => {
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

  it('verify reads each canonical record once and keeps identity/open-turn evidence advisory', async () => {
    const root = await withTurns(2)
    const dataRoot = join(root, '.scry')
    const expected = summarizeTurnRecords(await listRecords(dataRoot), undefined, { scope: 'workspace' }).identity
    await writeFile(join(dataRoot, 'health.json'), JSON.stringify({ schemaVersion: 1, pendingCount: 2 }))
    for (const name of await readdir(join(dataRoot, 'records'))) recordReads.set(join(dataRoot, 'records', name), 0)
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, records: 2, errors: [], identity: expected, openTurnsPending: 2,
      advisories: expect.arrayContaining(['open turns pending recovery: 2']) })
    expect([...recordReads.values()]).toEqual([1, 1])
  })

  it.each(['malformed JSON', 'invalid schema'])('verify retains exit 4 and unknown identity for %s without rereading', async (failure) => {
    const root = await withTurns(2)
    const recordsRoot = join(root, '.scry', 'records')
    const names = (await readdir(recordsRoot)).sort()
    const path = join(recordsRoot, names[1]!)
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, failure === 'malformed JSON' ? '{broken' : JSON.stringify({ ...original, schemaVersion: 99 }))
    for (const name of names) recordReads.set(join(recordsRoot, name), 0)
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, records: 2, identity: null, errors: [expect.any(String)], advisories: [] })
    expect([...recordReads.values()]).toEqual([1, 1])
  })

  it('verify retains identity for readable records even when sequence integrity fails', async () => {
    const root = await withTurns(2)
    const recordsRoot = join(root, '.scry', 'records')
    const names = (await readdir(recordsRoot)).sort()
    await rm(join(recordsRoot, names[0]!))
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(4)
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false, records: 1,
      errors: [expect.stringContaining('sequence gap')], identity: { model: { coverage: { totalTurns: 1 } } } })
  })

  it('verify preserves an empty store as valid with no identity observations', async () => {
    const root = await workspace()
    const stdout = captureStdout()
    await expect(runScryCli(['turns', 'verify', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toEqual({ ok: true, records: 0, errors: [], archivedThrough: 0,
      identity: null, openTurnsPending: 0, advisories: [] })
  })

  it('verify does not turn an observer exception into a corrupt-record report', async () => {
    const root = await withTurns(1)
    await expect(verifyStore(join(root, '.scry'), () => { throw new Error('observer failed') })).rejects.toThrow('observer failed')
    await expect(verifyStore(join(root, '.scry'))).resolves.toMatchObject({ ok: true, records: 1, errors: [] })
  })

  it('maintenance 默认只输出计划，不执行删除', async () => {
    const root = await withTurns(1)
    const stdout = captureStdout()
    await expect(runScryCli(['records', 'maintain', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({ action: 'maintain', status: 'planned', applied: false, blockedBy: [] })

    vi.restoreAllMocks()
    const applied = captureStdout()
    await expect(runScryCli(['records', 'maintain', '--apply', '--workspace', root])).resolves.toBe(0)
    expect(JSON.parse(applied.text())).toMatchObject({ action: 'maintain', status: 'applied', applied: true, blockedBy: [] })
  })

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
    const notifications = join(root, '.scry', 'notifications')
    await mkdir(join(notifications, 'commit-hooks'), { recursive: true })
    const other = JSON.stringify({ schemaVersion: 1, hookFingerprint: 'other-app', ackedThrough: 2 })
    await writeFile(join(notifications, 'commit-hook-state.json'), other)
    await writeFile(join(notifications, 'commit-hooks', `${stableHash('other-app')}.json`), other)
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
