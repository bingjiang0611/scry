import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { handleRecorderHook, mergeTurnTraceEvents } from './recorder'
import { commitRecord, exportRecords, listRecords, readHealth, verifyStore } from './store'

const roots: string[] = []
const pexecFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-recorder-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

const payload = (sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: sessionId,
  timestamp: '2026-07-19T12:00:00.000Z',
  ...extra
})

async function completeTurn(root: string, sessionId: string, prompt = 'implement feature'): Promise<void> {
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(sessionId, { prompt }) })
  await handleRecorderHook({
    provider: 'claude',
    event: 'PreToolUse:Bash',
    workspace: root,
    payload: payload(sessionId, { tool_name: 'Bash', tool_use_id: `${sessionId}-tool`, tool_input: { command: 'printf ok' } })
  })
  await handleRecorderHook({
    provider: 'claude',
    event: 'PostToolUse:Bash',
    workspace: root,
    payload: payload(sessionId, { tool_name: 'Bash', tool_use_id: `${sessionId}-tool`, tool_response: 'ok' })
  })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload(sessionId, { timestamp: '2026-07-19T12:00:01.000Z' }) })
}

describe('turn recorder state machine', () => {
  it('每个顶层轮次只提交一条正式记录，重复 Stop 不重复', async () => {
    const root = await workspace()
    await completeTurn(root, 's1')
    const duplicate = await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })
    const records = await listRecords(join(root, '.scry'))

    expect(duplicate.status).toBe('duplicate')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ sequence: 1, sessionId: 's1', generation: 1, turnIndex: 1, status: 'completed' })
    expect(records[0].tools.value).toEqual([
      expect.objectContaining({ id: 's1-tool', name: 'Bash', status: 'success', outputSummary: 'ok' })
    ])
    expect(records[0].usage).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
    expect(records[0].diff).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })

  it('相同 prompt 的下一轮不会误去重，open 状态内的重复 prompt 会去重', async () => {
    const root = await workspace()
    const first = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    const duplicate = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })

    expect(first.status).toBe('started')
    expect(duplicate.status).toBe('duplicate')
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.generation, record.turnIndex])).toEqual([[1, 1], [2, 2]])
  })

  it('新 prompt 到来时把未结束旧轮提交为 interrupted', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'one' }) })
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'two', timestamp: '2026-07-19T12:00:02.000Z' }) })
    await handleRecorderHook({ provider: 'codex', event: 'turn/completed', workspace: root, payload: payload('c1', { timestamp: '2026-07-19T12:00:03.000Z' }) })

    expect((await listRecords(join(root, '.scry'))).map((record) => record.status)).toEqual(['interrupted', 'completed'])
  })

  it('closing 轮的 transcript 仍在变化时，新 prompt 也不会被吞掉', async () => {
    const root = await workspace()
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, '')
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'one', transcript_path: transcript }) })
    const timer = setInterval(() => void appendFile(transcript, '{}\n'), 10)
    try {
      const pending = await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1', { timestamp: '2026-07-19T12:00:01.000Z' }) })
      expect(pending.status).toBe('pending')
      expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 1 })
      const next = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'two', timestamp: '2026-07-19T12:00:02.000Z' }) })
      expect(next.status).toBe('started')
    } finally {
      clearInterval(timer)
    }
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1', { timestamp: '2026-07-19T12:00:03.000Z' }) })
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.turnIndex, record.status])).toEqual([[1, 'completed'], [2, 'completed']])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 0 })
  })

  it('没有 open turn 的工具事件进入 orphan，不猜测归属', async () => {
    const root = await workspace()
    const result = await handleRecorderHook({ provider: 'qoder', event: 'PreToolUse:Read', workspace: root, payload: payload('q1', { tool_name: 'Read' }) })
    expect(result.status).toBe('orphan')
    expect(await listRecords(join(root, '.scry'))).toEqual([])
  })
})

describe('lifecycle/transcript merge', () => {
  it('优先 transcript 的同一 toolUseId，并去掉 lifecycle 的重复 assistant/usage', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-tool', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'life-text', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'life-usage', kind: 'harness', stage: 'result', tokensIn: 9 })
    ]
    const transcript = [
      event({ id: 'transcript-tool', ts: '2026-01-01T00:00:01Z', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'transcript-text', ts: '2026-01-01T00:00:01Z', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'transcript-usage', ts: '2026-01-01T00:00:01Z', kind: 'harness', stage: 'result', text: 'transcript assistant usage', tokensIn: 9 })
    ]
    expect(mergeTurnTraceEvents(lifecycle, transcript).map((item) => item.id)).toEqual(['transcript-tool', 'transcript-text', 'transcript-usage'])
  })
})

describe('record store cursor and recovery semantics', () => {
  it('跨 session 使用全局 sequence，分页 snapshot 不漏晚提交', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    await completeTurn(root, 'b')
    const first = await exportRecords(join(root, '.scry'), { after: 0, limit: 1 })
    await completeTurn(root, 'a', 'late')
    const second = await exportRecords(join(root, '.scry'), { after: first.nextCursor, limit: 10, snapshotMaxSequence: first.snapshotMaxSequence })
    const nextSnapshot = await exportRecords(join(root, '.scry'), { after: second.nextCursor, limit: 10 })

    expect(first.records.map((record) => record.sequence)).toEqual([1])
    expect(first).toMatchObject({ nextCursor: 1, hasMore: true, snapshotMaxSequence: 2 })
    expect(second.records.map((record) => record.sequence)).toEqual([2])
    expect(nextSnapshot.records.map((record) => record.sequence)).toEqual([3])
  })

  it('sequence cache 丢失后从正式记录重建，不覆盖旧记录', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    await unlink(join(root, '.scry', 'state', 'next-sequence.json'))
    await writeFile(join(root, '.scry', 'records', 'rename-before-crash.tmp'), '{"partial":true}')
    await completeTurn(root, 'b')
    expect((await listRecords(join(root, '.scry'))).map((record) => record.sequence)).toEqual([1, 2])
    await expect(verifyStore(join(root, '.scry'))).resolves.toEqual({ ok: true, records: 2, errors: [] })
  })

  it('正式文件已 rename 后重试提交保持幂等，并能回收死进程锁', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    const [record] = await listRecords(join(root, '.scry'))
    const { sequence: _sequence, ...draft } = record
    await expect(commitRecord(join(root, '.scry'), draft)).resolves.toMatchObject({ status: 'duplicate', record: { sequence: 1 } })

    const stale = join(root, '.scry', 'locks', 'commit.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }))
    await completeTurn(root, 'b')
    expect((await listRecords(join(root, '.scry'))).map((item) => item.sequence)).toEqual([1, 2])
  })

  it('立即回收刚刚崩溃进程留下的锁，不等待 TTL', async () => {
    const root = await workspace()
    const stale = join(root, '.scry', 'locks', 'commit.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }))
    const started = Date.now()
    await completeTurn(root, 'recent-dead-lock')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('缺配置或外部熔断时不创建 .scry', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'scry-recorder-disabled-'))
    roots.push(missing)
    const noConfig = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: missing, payload: payload('s1') })
    expect(noConfig).toMatchObject({ status: 'disabled', reason: 'missing_config' })
    await expect(access(join(missing, '.scry'))).rejects.toThrow()

    const root = await workspace()
    const envDisabled = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1'), env: { SCRY_RECORDER_ENABLED: '0' } })
    expect(envDisabled).toMatchObject({ status: 'disabled', reason: 'environment' })
    await expect(access(join(root, '.scry'))).rejects.toThrow()

    await writeFile(join(root, '.scry-disabled'), '')
    const sentinel = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1') })
    expect(sentinel).toMatchObject({ status: 'disabled', reason: 'sentinel' })
    await expect(access(join(root, '.scry'))).rejects.toThrow()
  })

  it('正式记录是独立 JSON 文件且不含上传配置', async () => {
    const root = await workspace()
    await completeTurn(root, 's1')
    const names = await import('node:fs/promises').then(({ readdir }) => readdir(join(root, '.scry', 'records')))
    expect(names).toHaveLength(1)
    const source = await readFile(join(root, '.scry', 'records', names[0]), 'utf8')
    expect(source).not.toContain('reportTraces')
    expect(source).not.toContain('upload')
  })
})

describe('nested Git turn diff', () => {
  it('按真实子仓归属记录本轮净变化', async () => {
    const root = await workspace()
    const repository = join(root, 'plugin-commerce-app')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(repository))
    await pexecFile('git', ['init'], { cwd: repository })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: repository })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', '.'], { cwd: repository })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: repository })
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.repositories = { mode: 'discover-nested-git', maxDepth: 2 }
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'opencode', event: 'chat.message', workspace: root, payload: payload('o1', { prompt: 'edit nested repo' }) })
    await writeFile(join(repository, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'opencode', event: 'session.idle', workspace: root, payload: payload('o1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.diff).toMatchObject({ status: 'available', quality: 'exact' })
    const canonicalRepository = await realpath(repository)
    expect(record.diff.value?.[0]).toMatchObject({ status: 'captured', repoRoot: canonicalRepository })
    expect(record.diff.value?.[0].files).toEqual([
      expect.objectContaining({ path: join(canonicalRepository, 'a.txt'), added: 1, deleted: 1, patchStatus: 'captured' })
    ])
  }, 15_000)

  it('即使接入方未忽略 .scry，Recorder 自身文件也不污染 Diff', async () => {
    const root = await workspace()
    await pexecFile('git', ['init'], { cwd: root })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', 'a.txt'], { cwd: root })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'edit root' }) })
    await writeFile(join(root, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('c1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.diff.value?.[0].files).toEqual([
      expect.objectContaining({ path: join(await realpath(root), 'a.txt'), added: 1, deleted: 1, patchStatus: 'captured' })
    ])
  }, 15_000)
})
