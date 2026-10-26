import { mkdir, writeFile, rm, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { safeKey, readHealth, listRecords } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite6(): void {


  it('cold-direct fallback 等待正在处理的同 session 事件，不误记 dropped', async () => {
    const root = await workspace()
    const lock = join(root, '.scry', 'locks', 'sessions', 'codex', `${safeKey('c1')}.lock`)
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    const release = new Promise<void>((resolve) => {
      // Keep one real filesystem contention path, but synchronization does not require sleeping
      // past the generic two-second lock default.
      setTimeout(() => void rm(lock, { recursive: true, force: true }).then(() => resolve()), 100)
    })

    const [first, retry] = await Promise.all([
      handleRecorderHook({
        provider: 'codex',
        event: 'UserPromptSubmit',
        workspace: root,
        payload: payload('c1', { prompt: 'one' })
      }),
      handleRecorderHook({
        provider: 'codex',
        event: 'UserPromptSubmit',
        workspace: root,
        payload: payload('c1', { prompt: 'one' })
      })
    ])
    await release

    expect([first.status, retry.status].sort()).toEqual(['duplicate', 'started'])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ droppedEvents: 0 })
  }, 10_000)

  it('Codex 相同 prompt 的失败 attempt 与重试按 task lifecycle 分成两轮', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'same', turn_id: 'attempt-1' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        prompt: 'same',
        turn_id: 'attempt-1',
        timestamp: '2026-07-19T12:00:01.000Z',
        status: 'failed',
        error: 'stream disconnected'
      })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', {
        prompt: 'same',
        turn_id: 'attempt-2',
        timestamp: '2026-07-19T12:00:02.000Z'
      })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        turn_id: 'attempt-2',
        timestamp: '2026-07-19T12:00:03.000Z'
      })
    })

    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { providerTurnId: 'attempt-1', turnIndex: 1, status: 'failed' },
      { providerTurnId: 'attempt-2', turnIndex: 2, status: 'completed' }
    ])
  })

  it('历史 providerTurnId 延迟重放不会终止当前轮或制造新轮', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'one', turn_id: 'turn-1' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'turn-1', timestamp: '2026-07-19T12:00:01.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'two', turn_id: 'turn-2', timestamp: '2026-07-19T12:00:02.000Z' })
    })
    const replay = await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'one', turn_id: 'turn-1', timestamp: '2026-07-19T12:00:03.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'turn-2', timestamp: '2026-07-19T12:00:04.000Z' })
    })

    expect(replay.status).toBe('duplicate')
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.providerTurnId, record.status])).toEqual([
      ['turn-1', 'completed'],
      ['turn-2', 'completed']
    ])
  })

  it('新 prompt 到来时把未结束旧轮提交为 interrupted', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'one' }) })
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'two', timestamp: '2026-07-19T12:00:02.000Z' }) })
    await handleRecorderHook({ provider: 'codex', event: 'turn/completed', workspace: root, payload: payload('c1', { timestamp: '2026-07-19T12:00:03.000Z' }) })

    expect((await listRecords(join(root, '.scry'))).map((record) => record.status)).toEqual(['interrupted', 'completed'])
  })

  it('transcript 仍在变化时以有界快照提交，不留下 pending 也不吞下一轮', async () => {
    const root = await workspace()
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'one' }
    })}\n`)
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'one', transcript_path: transcript }) })
    const timer = setInterval(() => void appendFile(transcript, '{}\n'), 10)
    try {
      const committed = await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1', { timestamp: '2026-07-19T12:00:01.000Z' }) })
      expect(committed.status).toBe('committed')
      expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 0 })
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

  it('Codex guardian 子 agent 的 prompt 由 rollout session_meta 识别，不提前结束父轮也不产生 orphan', async () => {
    const root = await workspace()
    const guardianRollout = join(root, 'rollout-2026-07-19T12-00-00-019fguardian.jsonl')
    await writeFile(guardianRollout, `${JSON.stringify({ type: 'session_meta', payload: { id: '019fguardian', source: { subagent: { other: 'guardian' } } } })}\n`)
    const hook = (event: string, extra: Record<string, unknown>) => handleRecorderHook({ provider: 'codex', event, workspace: root, payload: payload('main-g1', extra) })
    await hook('UserPromptSubmit', { prompt: 'deploy', turn_id: 'parent-turn' })
    const guardianStart = await hook('UserPromptSubmit', { prompt: 'review this approval', turn_id: 'guardian-turn', transcript_path: guardianRollout, timestamp: '2026-07-19T12:00:00.100Z' })
    await hook('PreToolUse', { turn_id: 'guardian-turn', transcript_path: guardianRollout, tool_name: 'Bash', tool_use_id: 'g-call', tool_input: { command: 'cat plan' }, timestamp: '2026-07-19T12:00:00.200Z' })
    await hook('Stop', { turn_id: 'guardian-turn', transcript_path: guardianRollout, timestamp: '2026-07-19T12:00:00.300Z' })
    const parentTool = await hook('PostToolUse', { turn_id: 'parent-turn', tool_name: 'Bash', tool_use_id: 'p-call', tool_response: 'ok', timestamp: '2026-07-19T12:00:00.400Z' })
    await hook('Stop', { turn_id: 'parent-turn', timestamp: '2026-07-19T12:00:01.000Z' })

    expect(guardianStart).toEqual({ status: 'recorded', reason: 'sub-agent turn attributed to the open parent turn' })
    expect(parentTool.status).toBe('recorded')
    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.providerTurnId, record.status, record.completedAt])).toEqual([
      ['parent-turn', 'completed', '2026-07-19T12:00:01.000Z']
    ])
    expect(records[0].user.value?.text).toBe('deploy')
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0 })
  })

  it('入参中的 Scry 子 agent 标记不被信任', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('forge-1', { prompt: 'one', turn_id: 't1' }) })
    const forged = await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('forge-1', { prompt: 'two', turn_id: 't2', scry_codex_subagent_transcript: true, timestamp: '2026-07-19T12:00:02.000Z' }) })
    expect(forged.status).toBe('started')
  })

  it('Codex 子 agent 自带 turn_id 的生命周期事件归属当前顶层轮，不再丢成 orphan', async () => {
    const root = await workspace()
    const subagent = {
      turn_id: 'child-turn',
      agent_id: 'agent-1',
      agent_type: 'default'
    }
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('sub-1', { prompt: 'spawn a sub agent', turn_id: 'parent-turn', hook_event_name: 'UserPromptSubmit' })
    })
    const started = await handleRecorderHook({
      provider: 'codex',
      event: 'PreToolUse:Bash',
      workspace: root,
      payload: payload('sub-1', {
        ...subagent,
        timestamp: '2026-07-19T12:00:00.100Z',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'child-call',
        tool_input: { command: 'echo from-subagent' }
      })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'PostToolUse:Bash',
      workspace: root,
      payload: payload('sub-1', {
        ...subagent,
        timestamp: '2026-07-19T12:00:00.200Z',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'child-call',
        tool_response: 'from-subagent'
      })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'Stop',
      workspace: root,
      payload: payload('sub-1', { turn_id: 'parent-turn', hook_event_name: 'Stop', timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(started).toEqual({ status: 'recorded', reason: 'sub-agent turn attributed to the open parent turn' })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0 })
    expect(record).toMatchObject({ providerTurnId: 'parent-turn', turnIndex: 1, status: 'completed' })
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'child-call', name: 'Bash', status: 'success', outputSummary: 'from-subagent' })
    ])
    expect(record.hooks).toMatchObject({ status: 'partial', quality: 'inferred' })
    expect(record.hooks.value).toEqual([
      expect.objectContaining({ event: 'UserPromptSubmit', lifecycleEvents: 1, status: 'unknown' }),
      expect.objectContaining({ event: 'PreToolUse', lifecycleEvents: 1, status: 'unknown' }),
      expect.objectContaining({ event: 'PostToolUse', lifecycleEvents: 1, status: 'unknown' }),
      expect.objectContaining({ event: 'Stop', lifecycleEvents: 1, status: 'unknown' })
    ])
  })

  it('子 agent 的 transcript 不改写顶层轮的 transcript 锚点', async () => {
    const root = await workspace()
    const parent = join(root, 'parent.jsonl')
    const child = join(root, 'child.jsonl')
    await writeFile(parent, `${JSON.stringify({ timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-turn' } })}\n`)
    await writeFile(child, `${JSON.stringify({ timestamp: '2026-07-19T12:00:00.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } })}\n`)
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('sub-2', { prompt: 'spawn', turn_id: 'parent-turn', hook_event_name: 'UserPromptSubmit', transcript_path: parent })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'PreToolUse:Bash',
      workspace: root,
      payload: payload('sub-2', {
        turn_id: 'child-turn',
        agent_id: 'agent-1',
        agent_type: 'default',
        hook_event_name: 'PreToolUse',
        transcript_path: child,
        tool_name: 'Bash',
        tool_use_id: 'child-call'
      })
    })

    const open = JSON.parse(await readFile(
      join(root, '.scry', 'runtime', 'codex', safeKey('sub-2'), 'open.json'),
      'utf8'
    )) as Record<string, unknown>
    expect(open).toMatchObject({ providerTurnId: 'parent-turn', transcriptPath: parent })
  })
}
