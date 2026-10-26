import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, safeKey } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite9(): void {

  it('从 archived_sessions 恢复 turn_aborted，并按 interrupted 提交原 open 轮次', async () => {
    const root = await workspace()
    const codexHome = join(root, '.codex')
    const active = join(codexHome, 'sessions', '2026', '07', '19', 'rollout-aborted.jsonl')
    const archived = join(codexHome, 'archived_sessions', 'rollout-aborted.jsonl')
    await mkdir(join(active, '..'), { recursive: true })
    const startLines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-aborted' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'cancel this work' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-aborted',
          arguments: JSON.stringify({ cmd: 'git status --short' })
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-aborted', output: 'clean' }
      }
    ]
    await writeFile(active, `${startLines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('codex-session-aborted', {
        prompt: 'cancel this work',
        turn_id: 'codex-turn-aborted',
        rollout_path: active
      })
    })

    await mkdir(join(codexHome, 'archived_sessions'), { recursive: true })
    await writeFile(archived, `${[
      ...startLines,
      {
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: 'codex-turn-aborted',
          reason: 'interrupted',
          started_at: 1784462400,
          completed_at: 1784462408,
          duration_ms: 7469
        }
      }
    ].map((line) => JSON.stringify(line)).join('\n')}\n`)
    await unlink(active)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 0 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record).toMatchObject({
      sessionId: 'codex-session-aborted',
      providerTurnId: 'codex-turn-aborted',
      status: 'interrupted',
      completedAt: '2026-07-19T12:00:08.000Z',
      durationMs: 7469,
      user: { value: { text: 'cancel this work' } }
    })
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'call-aborted', name: 'Bash', status: 'success' })
    ])
  })

  it('拒绝 active duration 明显长于墙钟的 turn_aborted 终态', async () => {
    const root = await workspace()
    const rollout = join(root, '.codex', 'sessions', '2026', '07', '19', 'bad-abort-timing.jsonl')
    await mkdir(join(rollout, '..'), { recursive: true })
    await writeFile(rollout, [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'bad-timing-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'bad timing' } },
      {
        timestamp: '2026-07-19T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: 'bad-timing-turn',
          reason: 'interrupted',
          started_at: 1784462400,
          completed_at: 1784462402,
          duration_ms: 4000
        }
      }
    ].map((line) => JSON.stringify(line)).join('\n'))
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('bad-timing-session', {
        prompt: 'bad timing',
        turn_id: 'bad-timing-turn',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:00.000Z'
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  })

  it('不使用其他 turn 的 turn_aborted 终态关闭当前 open', async () => {
    const root = await workspace()
    const rollout = join(root, 'wrong-aborted-turn.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'target-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'target prompt' } },
      {
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: 'different-turn', reason: 'interrupted' }
      }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('codex-session-wrong-abort', {
        prompt: 'target prompt',
        turn_id: 'target-turn',
        rollout_path: rollout
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  })

  it('已有权威 Codex turn id 时拒绝缺失 turn_id 的终态', async () => {
    const root = await workspace()
    const rollout = join(root, 'missing-aborted-turn-id.jsonl')
    await writeFile(rollout, `${[
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'target-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'target prompt' } },
      { timestamp: '2026-07-19T12:00:01.000Z', type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    ].map((line) => JSON.stringify(line)).join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('codex-session-missing-abort-id', {
        prompt: 'target prompt', turn_id: 'target-turn', rollout_path: rollout
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  })

  it('recovery 与同 session 新 start 串行，不让旧 open 覆盖或删除新轮', async () => {
    const root = await workspace()
    const rollout = join(root, 'recovery-start-race.jsonl')
    await writeFile(rollout, `${[
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'old prompt' } },
      { timestamp: '2026-07-19T12:00:01.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'old-turn', reason: 'interrupted' } }
    ].map((line) => JSON.stringify(line)).join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex', event: 'turn.started', workspace: root,
      payload: payload('codex-race-session', { prompt: 'old prompt', turn_id: 'old-turn', rollout_path: rollout })
    })
    let releaseRecovery = (): void => {}
    const recoveryBlocked = new Promise<void>((resolve) => { releaseRecovery = resolve })
    let recoveryLocked = (): void => {}
    const recoveryHasLock = new Promise<void>((resolve) => { recoveryLocked = resolve })
    const recovery = recoverRecorder(root, process.env, async () => {
      recoveryLocked()
      await recoveryBlocked
    })
    await recoveryHasLock
    const next = handleRecorderHook({
      provider: 'codex', event: 'turn.started', workspace: root,
      payload: payload('codex-race-session', {
        prompt: 'new prompt', turn_id: 'new-turn', rollout_path: rollout, timestamp: '2026-07-19T12:00:02.000Z'
      })
    })
    releaseRecovery()

    await expect(recovery).resolves.toEqual({ recovered: 1, pending: 0, expired: 0 })
    await expect(next).resolves.toMatchObject({ status: 'started' })
    const open = JSON.parse(await readFile(join(
      root, '.scry', 'runtime', 'codex', safeKey('codex-race-session'), 'open.json'
    ), 'utf8')) as Record<string, unknown>
    expect(open).toMatchObject({ generation: 2, providerTurnId: 'new-turn', prompt: 'new prompt', status: 'open' })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      { generation: 1, providerTurnId: 'old-turn', status: 'interrupted' }
    ])
  })

  it('只按 context_compacted 记录一次 Codex rollout compact', async () => {
    const root = await workspace()
    const rollout = join(root, 'compact-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-compact' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'continue' } },
      { timestamp: '2026-07-19T12:00:00.100Z', type: 'event_msg', payload: { type: 'context_compacted' } },
      { timestamp: '2026-07-19T12:00:00.101Z', type: 'response_item', payload: { type: 'compaction', encrypted_content: 'opaque' } },
      { timestamp: '2026-07-19T12:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'codex-turn-compact' } }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'continue', turn_id: 'codex-turn-compact', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        turn_id: 'codex-turn-compact',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.compactions?.value).toHaveLength(1)
  })

  it('双 hook 入口重放同一 Codex tool lifecycle 时按 call_id 只记录一次', async () => {
    const root = await workspace()
    const rollout = join(root, 'duplicate-lifecycle-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-1' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: 'git status --short' })
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'clean' }
      },
      {
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'codex-turn-1', last_agent_message: 'done' }
      }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'inspect', turn_id: 'codex-turn-1', rollout_path: rollout })
    })
    for (const timestamp of ['2026-07-19T12:00:00.110Z', '2026-07-19T12:00:00.120Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('c1', {
          timestamp,
          turn_id: 'codex-turn-1',
          tool_name: 'Bash',
          tool_use_id: 'call-1',
          tool_input: { command: 'git status --short' }
        })
      })
    }
    for (const timestamp of ['2026-07-19T12:00:00.310Z', '2026-07-19T12:00:00.320Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('c1', {
          timestamp,
          turn_id: 'codex-turn-1',
          tool_name: 'Bash',
          tool_use_id: 'call-1',
          tool_response: 'clean'
        })
      })
    }
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        turn_id: 'codex-turn-1',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'call-1', name: 'Bash', status: 'success' })
    ])
  })
}
