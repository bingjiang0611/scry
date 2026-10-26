import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RECORDER_VERSION, listRecords } from '../core/turn-recorder/store'
import { readRecorderContent } from '../core/turn-recorder/content-store'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { parseArgs, runScryCli } from './scry'
import { collectSupportBundle } from './support-bundle'
import { roots, workspace, captureStdout } from './scry.test-fixture.js'

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
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T13:00:00Z'))
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
