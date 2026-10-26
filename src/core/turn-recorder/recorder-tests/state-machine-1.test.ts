import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { safeKey, readHealth, listRecords } from '../store'
import { workspace, payload, completeTurn } from './fixture.test'

export function registerSuite1(): void {

  it.each(['claude', 'codex', 'qoder', 'opencode'] as const)('missing-start %s Stop preserves bounded payload once instead of claiming duplicate', async (provider) => {
    const root = await workspace()
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.toolOutput = 'full'
    config.capture.toolContentFieldBytes = 1024
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    // OpenCode's session.idle plugin dispatches Stop, not session.idle itself.
    const input = { provider, workspace: root, event: 'Stop', payload: payload('missing-start', {
      transcript_path: join(root, 'absent-transcript.jsonl'), detail: 'provider detail'
    }) }
    await expect(handleRecorderHook(input)).resolves.toMatchObject({ status: 'orphan' })
    await expect(handleRecorderHook(input)).resolves.toMatchObject({ status: 'orphan' })
    await recoverRecorder(root)
    const orphans = join(root, '.scry/runtime', provider, safeKey('missing-start'), 'orphans')
    const files = await readdir(orphans)
    expect(files).toHaveLength(1)
    const orphan = JSON.parse(await readFile(join(orphans, files[0]), 'utf8'))
    expect(orphan).toMatchObject({ event: 'Stop', reason: 'missing_start', payload: { storage: 'complete' } })
    expect(JSON.parse(orphan.payload.content)).toEqual(input.payload)
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 1, missingStartTerminals: 1 })
    expect(await readFile(join(root, '.scry/logs/recorder.log'), 'utf8')).toContain('missing_start')
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
  })

  it('missing-start after a committed turn is not proved duplicate by session identity alone', async () => {
    const root = await workspace()
    await completeTurn(root, 'later-missing')
    await recoverRecorder(root)
    await expect(handleRecorderHook({ provider: 'claude', workspace: root, event: 'Stop',
      payload: payload('later-missing', { timestamp: '2026-07-19T13:00:00.000Z' })
    })).resolves.toMatchObject({ status: 'orphan' })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ missingStartTerminals: 1 })
  })

  it('orphan tool payload respects capture policy and byte limits', async () => {
    const root = await workspace()
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.toolOutput = 'full'
    config.capture.toolContentFieldBytes = 1024
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    const input = { provider: 'claude' as const, workspace: root, event: 'PostToolUse',
      payload: payload('orphan-tool', { tool_response: '秘'.repeat(2000) }) }
    await handleRecorderHook(input)
    const directory = join(root, '.scry/runtime/claude', safeKey('orphan-tool'), 'orphans')
    const [file] = await readdir(directory)
    const orphan = JSON.parse(await readFile(join(directory, file), 'utf8'))
    expect(orphan.payload).toMatchObject({ storage: 'truncated', encoding: 'json-fragment', reasons: ['field_budget'] })
    expect(Buffer.byteLength(orphan.payload.content)).toBeLessThanOrEqual(1024)
    config.capture.prompt = false
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await handleRecorderHook({ ...input, payload: payload('private-orphan', { prompt: 'DO_NOT_STORE' }) })
    const privateDirectory = join(root, '.scry/runtime/claude', safeKey('private-orphan'), 'orphans')
    const [privateFile] = await readdir(privateDirectory)
    const privateText = await readFile(join(privateDirectory, privateFile), 'utf8')
    expect(privateText).not.toContain('DO_NOT_STORE')
    expect(JSON.parse(privateText)).toMatchObject({ payload: { storage: 'omitted' }, omissionReason: 'capture_policy' })
  })

  it('interrupted turn ends at its last credible evidence, never at the next prompt', async () => {
    const root = await workspace()
    const base = { provider: 'claude' as const, workspace: root }
    const now = Date.now()
    const start = new Date(now - 60 * 60_000).toISOString()
    const reset = new Date(now - 47 * 60_000).toISOString()
    const nextPrompt = new Date(now - 24 * 60_000).toISOString()
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('reset', { prompt: 'go', timestamp: start }) })
    await handleRecorderHook({
      ...base,
      event: 'PostToolUse',
      payload: payload('reset', { tool_name: 'Bash', tool_use_id: 't', tool_response: 'ok', timestamp: reset })
    })
    // Connection reset: no Stop ever arrives, and the user types again 23 minutes later.
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('reset', { prompt: 'again', timestamp: nextPrompt }) })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'interrupted', completedAt: reset, durationMs: 13 * 60_000 })
    expect(records[0].termination).toMatchObject({
      status: 'partial',
      quality: 'estimated',
      value: { reason: 'superseded_by_next_turn', completedAtSource: 'last_observed_activity', observedAt: nextPrompt }
    })
  })

  it.each(['SessionEnd', 'process.exit'])('%s closes the open turn at once and repeats stay idempotent', async (event) => {
    const root = await workspace()
    const base = { provider: 'claude' as const, workspace: root }
    const now = Date.now()
    const start = new Date(now - 60 * 60_000).toISOString()
    const ended = new Date(now - 47 * 60_000).toISOString()
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('ended', { prompt: 'go', timestamp: start }) })
    const terminal = { ...base, event, payload: payload('ended', { timestamp: ended }) }
    // The hook only persists the boundary; aggregation belongs to recovery, not to the 3s budget.
    await expect(handleRecorderHook(terminal)).resolves.toMatchObject({ status: 'pending' })
    await expect(handleRecorderHook(terminal)).resolves.toMatchObject({ status: 'pending' })
    await recoverRecorder(root)
    await expect(handleRecorderHook(terminal)).resolves.toMatchObject({ status: 'duplicate' })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'interrupted', completedAt: ended, durationMs: 13 * 60_000 })
    expect(records[0].termination).toMatchObject({
      status: 'available',
      quality: 'exact',
      value: { reason: 'session_end', completedAtSource: 'provider_terminal_event' }
    })
    // A later prompt opens a new turn instead of reviving the closed one.
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('ended', { prompt: 'again', timestamp: new Date().toISOString() }) })
    expect((await listRecords(join(root, '.scry')))).toHaveLength(1)
  })

  it('a terminal timestamp from a skewed Provider clock is not trusted as the end time', async () => {
    const root = await workspace()
    const base = { provider: 'claude' as const, workspace: root }
    const start = new Date(Date.now() - 10 * 60_000).toISOString()
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('skewed', { prompt: 'go', timestamp: start }) })
    await handleRecorderHook({
      ...base,
      event: 'SessionEnd',
      payload: payload('skewed', { timestamp: new Date(Date.now() + 6 * 60 * 60_000).toISOString() })
    })
    await recoverRecorder(root)
    const [record] = await listRecords(join(root, '.scry'))
    expect(Date.parse(record.completedAt)).toBeLessThanOrEqual(Date.now())
    expect(record.termination?.status).toBe('partial')
    expect(record.termination?.quality).not.toBe('exact')
    expect(record.termination?.value?.reason).toBe('session_end')
    expect(['last_observed_activity', 'turn_start']).toContain(record.termination?.value?.completedAtSource)
  })

  it('早于本轮开始的终止时间同样不可信（时钟偏移是双向的）', async () => {
    const root = await workspace()
    const base = { provider: 'claude' as const, workspace: root }
    const start = new Date(Date.now() - 60_000).toISOString()
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('backwards', { prompt: 'go', timestamp: start }) })
    await handleRecorderHook({
      ...base,
      event: 'SessionEnd',
      // Provider 时钟落后：结束时间比本轮开始还早，它不可能是真实结束点
      payload: payload('backwards', { timestamp: new Date(Date.parse(start) - 10 * 60_000).toISOString() })
    })
    await recoverRecorder(root)
    const [record] = await listRecords(join(root, '.scry'))
    expect(Date.parse(record.completedAt)).toBeGreaterThanOrEqual(Date.parse(start))
    expect(record.termination?.status).toBe('partial')
    expect(record.termination?.quality).not.toBe('exact')
    expect(['last_observed_activity', 'turn_start']).toContain(record.termination?.value?.completedAtSource)
  })

  it('Stop without an explicit clock keeps the observed terminal honest', async () => {
    const root = await workspace()
    await completeTurn(root, 'observed-stop')
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('completed')
    expect(record.termination).toMatchObject({
      status: 'available',
      quality: 'exact',
      value: { reason: 'provider_terminal', completedAtSource: 'provider_terminal_event' }
    })
  })

  it('default full preserves raw first writes, pins byte budgets and retains body through duplicate Stop', async () => {
    const root = await workspace()
    const configPath = join(root, 'scry.config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    delete config.capture.toolOutput
    await writeFile(configPath, JSON.stringify(config))
    const base = { provider: 'claude' as const, workspace: root }
    await handleRecorderHook({ ...base, event: 'UserPromptSubmit', payload: payload('redacted', { prompt: 'test' }) })
    // A config edit cannot downgrade a started full capture to summary-only writes.
    config.capture.toolOutput = 'summary'
    await writeFile(configPath, JSON.stringify(config))
    await handleRecorderHook({ ...base, event: 'PreToolUse', payload: payload('redacted', { tool_name: 'Bash', tool_use_id: 't', tool_input: { password: 'INPUT_SENTINEL', command: 'echo ok' } }) })
    const output = `${'中😀'.repeat(300)}\nAuthorization: Bearer OUTPUT_SENTINEL\nfinished`
    await handleRecorderHook({ ...base, event: 'PostToolUse', payload: payload('redacted', { tool_name: 'Bash', tool_use_id: 't', tool_response: output }) })
    const scan = async (dir: string): Promise<string> => {
      const entries = await readdir(dir, { withFileTypes: true })
      return (await Promise.all(entries.map((entry) => entry.isDirectory() ? scan(join(dir, entry.name)) : readFile(join(dir, entry.name), 'utf8')))).join('\n')
    }
    const beforeCommit = await scan(join(root, '.scry'))
    expect(beforeCommit).toContain('INPUT_SENTINEL')
    expect(beforeCommit).toContain('OUTPUT_SENTINEL')
    expect(beforeCommit).not.toContain('[REDACTED]')
    const stop = { ...base, event: 'Stop', payload: payload('redacted', { timestamp: '2026-07-19T12:00:01.000Z' }) }
    await handleRecorderHook(stop)
    await handleRecorderHook(stop)
    await recoverRecorder(root)
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    const call = records[0].tools.value![0]
    expect(call.inputContent?.content).toContain('INPUT_SENTINEL')
    expect(call.inputContent?.redaction).toBe('disabled')
    expect(call.outputContent?.content).toContain('finished')
    expect(call.outputContent!.savedBytes).toBeGreaterThan(500)
    const afterCommit = await scan(join(root, '.scry'))
    expect(afterCommit).toContain('INPUT_SENTINEL')
    expect(afterCommit).toContain('OUTPUT_SENTINEL')
  })
}
