import { access, appendFile, chmod, mkdir, mkdtemp, open as openFile, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { handleRecorderHook, mergeTurnTraceEvents, recoverRecorder } from './recorder'
import { commitRecord, drainCommitNotifications, exportRecords, listRecords, readHealth, redeliverLatestCommitNotification, safeKey, verifyStore } from './store'

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

async function commitHook(root: string, exitCode = 0): Promise<{ path: string; capture: string }> {
  const path = join(root, 'commit-hook.sh')
  const capture = join(root, 'commit-hook.jsonl')
  await writeFile(path, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nexit ${exitCode}\n`)
  await chmod(path, 0o700)
  return { path, capture }
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

  it('Qoder 同一 promptId 的直连与 bridge 包装只开启一轮', async () => {
    const root = await workspace()
    const direct = payload('q1', { prompt: '/rate-workflow 1', promptId: 'qoder-turn-1' })
    const bridged = payload('q1', {
      prompt: '/rate-workflow 1',
      turn_id: 'bridge-envelope-id',
      raw_qoder_payload: { ...direct, promptId: 'qoder-turn-1' }
    })

    expect(await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: direct }))
      .toMatchObject({ status: 'started' })
    expect(await handleRecorderHook({ provider: 'qoder', event: 'UserPromptSubmit', workspace: root, payload: bridged }))
      .toMatchObject({ status: 'duplicate' })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', { promptId: 'qoder-turn-1', timestamp: '2026-07-19T12:00:01.000Z' })
    })

    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { providerTurnId: 'qoder-turn-1', turnIndex: 1, status: 'completed' }
    ])
  })

  it('Qoder 相同 prompt 但不同 promptId 仍保留两个真实轮次', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', { prompt: 'same', promptId: 'qoder-turn-1' })
    })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', {
        prompt: 'same',
        promptId: 'qoder-turn-2',
        timestamp: '2026-07-19T12:00:02.000Z'
      })
    })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', { promptId: 'qoder-turn-2', timestamp: '2026-07-19T12:00:03.000Z' })
    })

    expect((await listRecords(join(root, '.scry'))).map((record) => [record.providerTurnId, record.status])).toEqual([
      ['qoder-turn-1', 'interrupted'],
      ['qoder-turn-2', 'completed']
    ])
  })

  it('Qoder compact transcript 保留原始 hook prompt，并合并 compact 前后 assistant', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-session.jsonl')
    await writeFile(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'qoder-turn-1',
        message: {
          role: 'user',
          content: '<command-name>/rate-native-rate-workflow</command-name><command-args>84959911</command-args>'
        }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'qoder-turn-1',
        message: { content: [{ type: 'text', text: 'compact 前' }] }
      }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', isCompactSummary: true }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: [{ type: 'text', text: 'synthetic summary' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'qoder-turn-1',
        message: { content: [{ type: 'text', text: 'compact 后' }] }
      })
    ].join('\n'))
    await handleRecorderHook({
      provider: 'qoder',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('q1', {
        prompt: '/rate-native-rate-workflow 84959911',
        promptId: 'qoder-turn-1',
        transcript_path: transcript
      })
    })
    await handleRecorderHook({
      provider: 'qoder',
      event: 'Stop',
      workspace: root,
      payload: payload('q1', {
        promptId: 'qoder-turn-1',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.user.value?.text).toBe('/rate-native-rate-workflow 84959911')
    expect(record.assistant.value?.text).toBe('compact 前compact 后')
    expect(record.assistant.value?.text).not.toContain('synthetic summary')
    expect(record.compactions?.value).toEqual([
      expect.objectContaining({ eventId: expect.any(String) })
    ])
  })

  it('Claude 三条 task-notification 延续首轮，最终只提交两个真实轮次并保留原始 slash prompt', async () => {
    const root = await workspace()
    const transcript = join(root, 'claude-continuations.jsonl')
    const user = (promptId: string, content: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type: 'user',
      promptId,
      message: { role: 'user', content },
      ...extra
    })
    const tool = (promptId: string, id: string) => JSON.stringify({
      type: 'assistant',
      promptId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `printf ${id}` } }]
      }
    })
    const notificationText = (taskId: string) =>
      `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`
    const slashEnvelope = '<command-message>rate-workflow</command-message>\n' +
      '<command-name>/rate-workflow</command-name>\n' +
      '<command-args>85076624 写技术方案前停下</command-args>'
    await writeFile(transcript, `${[
      user('real-1', slashEnvelope),
      tool('real-1', 'root-tool')
    ].join('\n')}\n`)

    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-session', {
        prompt: '/rate-workflow 85076624 写技术方案前停下',
        promptId: 'real-1',
        transcript_path: transcript
      })
    })
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-session', {
        promptId: 'real-1',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })).resolves.toMatchObject({ status: 'pending' })

    for (const [index, taskId] of ['task-a', 'task-b', 'task-a'].entries()) {
      const promptId = `notification-${index + 1}`
      const toolId = `continuation-tool-${index + 1}`
      await appendFile(transcript, `${[
        user(promptId, notificationText(taskId), { origin: { kind: 'task-notification' }, promptSource: 'sdk' }),
        tool(promptId, toolId)
      ].join('\n')}\n`)
      await expect(handleRecorderHook({
        provider: 'claude',
        event: 'UserPromptSubmit',
        workspace: root,
        payload: payload('claude-session', {
          prompt: notificationText(taskId),
          promptId,
          origin: { kind: 'task-notification' },
          transcript_path: transcript,
          timestamp: `2026-07-19T12:00:0${index + 2}.000Z`
        })
      })).resolves.toMatchObject({ status: 'recorded' })
      await handleRecorderHook({
        provider: 'claude',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('claude-session', {
          promptId,
          tool_name: 'Bash',
          tool_use_id: toolId,
          tool_input: { command: `printf ${toolId}` }
        })
      })
      await expect(handleRecorderHook({
        provider: 'claude',
        event: 'Stop',
        workspace: root,
        payload: payload('claude-session', {
          promptId,
          transcript_path: transcript,
          timestamp: `2026-07-19T12:00:0${index + 5}.000Z`
        })
      })).resolves.toMatchObject({ status: 'pending' })
    }

    await appendFile(transcript, `${[
      user('real-2', '确认 写技术方案前停下'),
      tool('real-2', 'second-turn-tool')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-session', {
        prompt: '确认 写技术方案前停下',
        promptId: 'real-2',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:09.000Z'
      })
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-session', {
        promptId: 'real-2',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:10.000Z'
      })
    })).resolves.toMatchObject({ status: 'pending' })
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0 })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.providerTurnId, record.turnIndex, record.status, record.user.value?.text])).toEqual([
      ['real-1', 1, 'completed', '/rate-workflow 85076624 写技术方案前停下'],
      ['real-2', 2, 'completed', '确认 写技术方案前停下']
    ])
    expect(records[0].tools.value?.map((call) => call.id)).toEqual([
      'root-tool',
      'continuation-tool-1',
      'continuation-tool-2',
      'continuation-tool-3'
    ])
    expect(records.flatMap((record) => record.user.value?.text ?? []).join('\n')).not.toContain('<task-notification>')
  })

  it('Claude 指定 providerTurnId 未出现在 transcript 时保持 pending，绝不借用最后一轮', async () => {
    const root = await workspace()
    const transcript = join(root, 'claude-unmatched-id.jsonl')
    await writeFile(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'other-turn',
        message: { role: 'user', content: 'other prompt' }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'other-turn',
        message: { role: 'assistant', content: [{ type: 'text', text: 'other answer' }] }
      })
    ].join('\n'))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-unmatched', {
        prompt: 'target prompt',
        promptId: 'target-turn',
        transcript_path: transcript
      })
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-unmatched', {
        promptId: 'target-turn',
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 1 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])

    await appendFile(transcript, `\n${JSON.stringify({
      type: 'user',
      promptId: 'target-turn',
      message: { role: 'user', content: 'target prompt' }
    })}\n`)
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      {
        providerTurnId: 'target-turn',
        user: { value: { text: 'target prompt' } }
      }
    ])
  })

  it.each([
    ['promptId 优先于 turnId', { promptId: 'claude-root', turn_id: 'different-turn' }],
    ['promptEventId 可作为兼容回退', { prompt_event_id: 'claude-root' }]
  ])('Claude %s 并与 transcript promptId 对齐', async (_case, identity) => {
    const root = await workspace()
    const transcript = join(root, 'claude-provider-id-priority.jsonl')
    await writeFile(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'claude-root',
        message: { role: 'user', content: 'root prompt' }
      }),
      JSON.stringify({
        type: 'assistant',
        promptId: 'claude-root',
        message: { role: 'assistant', content: [{ type: 'text', text: 'root answer' }] }
      })
    ].join('\n'))

    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-id-priority', {
        ...identity,
        prompt: 'root prompt',
        transcript_path: transcript
      })
    })
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-id-priority', {
        ...identity,
        transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      { providerTurnId: 'claude-root', user: { value: { text: 'root prompt' } } }
    ])
  })

  it('Claude 只有 promptHash 时未匹配 transcript 也保持 pending', async () => {
    const root = await workspace()
    const transcript = join(root, 'claude-unmatched-hash.jsonl')
    await writeFile(transcript, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'other prompt' }
    }))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-unmatched-hash', { prompt: 'target prompt', transcript_path: transcript })
    })
    const stopped = await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-unmatched-hash', { transcript_path: transcript })
    })

    expect(stopped).toMatchObject({
      status: 'pending',
      reason: 'target turn is not present in transcript snapshot'
    })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  })

  it('Codex 连续两轮输入相同 prompt 时按不同时间边界分别记录', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'same' }) })
    const next = await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('c1', { prompt: 'same', timestamp: '2026-07-19T12:00:02.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { timestamp: '2026-07-19T12:00:03.000Z' })
    })

    expect(next.status).toBe('started')
    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { turnIndex: 1, status: 'interrupted', user: { value: { text: 'same' } } },
      { turnIndex: 2, status: 'completed', user: { value: { text: 'same' } } }
    ])
  })

  it('cold-direct fallback 等待正在处理的同 session 事件，不误记 dropped', async () => {
    const root = await workspace()
    const lock = join(root, '.scry', 'locks', 'sessions', 'codex', `${safeKey('c1')}.lock`)
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    const release = new Promise<void>((resolve) => {
      setTimeout(() => void rm(lock, { recursive: true, force: true }).then(() => resolve()), 2_100)
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

  it('managed Codex lifecycle 只维护身份，Stop 不用 rollout 抢先提交', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('managed-1', { prompt: '/rate-workflow 1', turn_id: 'root-turn' }),
      managed: true
    })
    const child = await handleRecorderHook({
      provider: 'codex',
      event: 'PreToolUse:Bash',
      workspace: root,
      payload: payload('managed-1', { turn_id: 'child-turn', tool_name: 'Bash', tool_use_id: 'child-call' })
    })
    const stopped = await handleRecorderHook({
      provider: 'codex',
      event: 'Stop',
      workspace: root,
      payload: payload('managed-1', { turn_id: 'root-turn', timestamp: '2026-07-19T12:00:01.000Z' })
    })
    const open = JSON.parse(await readFile(
      join(root, '.scry', 'runtime', 'codex', safeKey('managed-1'), 'open.json'),
      'utf8'
    )) as Record<string, unknown>

    expect(child.status).toBe('recorded')
    expect(stopped).toMatchObject({ status: 'pending', reason: 'managed turn awaits canonical Scry evidence' })
    expect(open).toMatchObject({ managedByScry: true, status: 'closing', captures: [] })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ orphanEvents: 0, pendingCount: 1 })
  })

  it('重复上报同一 toolUseId 时正式记录只保留一次逻辑调用', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'turn.started', workspace: root, payload: payload('c1', { prompt: 'dedupe', turn_id: 't1' }) })
    for (const timestamp of ['2026-07-19T12:00:00.100Z', '2026-07-19T12:00:00.200Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('c1', { timestamp, turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'printf ok' } })
      })
    }
    for (const timestamp of ['2026-07-19T12:00:00.300Z', '2026-07-19T12:00:00.400Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('c1', { timestamp, turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call-1', tool_response: 'ok' })
      })
    }
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { timestamp: '2026-07-19T12:00:01.000Z', turn_id: 't1' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'call-1', status: 'success' })
    ])
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

  it('同一 toolUseId 的 lifecycle 重放不因 timestamp 不同重复计数', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'start-1', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'start-2', ts: '2026-01-01T00:00:00.250Z', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'result-1', ts: '2026-01-01T00:00:01Z', stage: 'tool_result', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'result-2', ts: '2026-01-01T00:00:01.250Z', stage: 'tool_result', toolUseId: 't1', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, []).map((item) => item.id)).toEqual(['start-1', 'result-1'])
  })

  it('完整 transcript 使用不同 call id 时仍压掉 lifecycle 的同轮调用', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-start', toolUseId: 'exec-1', tool: 'Bash' }),
      event({ id: 'life-result', stage: 'tool_result', toolUseId: 'exec-1', tool: 'Bash' })
    ]
    const transcript = [
      event({ id: 'rollout-start', toolUseId: 'call_1', tool: 'Bash' }),
      event({ id: 'rollout-result', stage: 'tool_result', toolUseId: 'call_1', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, transcript).map((item) => item.id)).toEqual([
      'rollout-start',
      'rollout-result'
    ])
  })

  it('transcript 尚有异步调用未完成时保留 lifecycle 尾部证据', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-start', toolUseId: 'exec-tail', tool: 'Bash' }),
      event({ id: 'life-result', stage: 'tool_result', toolUseId: 'exec-tail', tool: 'Bash' })
    ]
    const transcript = [
      event({ id: 'rollout-start', toolUseId: 'call_pending', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, transcript, false).map((item) => item.id)).toEqual([
      'life-start',
      'life-result',
      'rollout-start'
    ])
  })
})

describe('Codex rollout recorder evidence', () => {
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

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0 })
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

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0 })
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

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0 })
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

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0 })
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

    await expect(recovery).resolves.toEqual({ recovered: 1, pending: 0 })
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

  it('解析 task/token_count/tool/skill/hook，未观测项不伪造 exact 空数组', async () => {
    const root = await workspace()
    const rollout = join(root, 'rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-1' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'run workflow' } },
      { timestamp: '2026-07-19T12:00:00.050Z', type: 'event_msg', payload: { type: 'agent_message', message: '先检查' } },
      { timestamp: '2026-07-19T12:00:00.051Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先检查' }] } },
      { timestamp: '2026-07-19T12:00:00.060Z', type: 'response_item', payload: { type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text: '定位文件' }] } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: "sed -n '1,120p' .codex/skills/rate-workflow/SKILL.md" })
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
      },
      { timestamp: '2026-07-19T12:00:00.250Z', type: 'event_msg', payload: { type: 'agent_message', message: '完成' } },
      { timestamp: '2026-07-19T12:00:00.251Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] } },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'event_msg',
        payload: {
          type: 'hook_started',
          hook_id: 'hook-1',
          hook_event: 'UserPromptSubmit',
          hook_name: 'trace_prompt.py',
          command: 'python3 .claude/hooks/trace_prompt.py'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.400Z',
        type: 'event_msg',
        payload: {
          type: 'hook_response',
          hook_id: 'hook-1',
          hook_event: 'UserPromptSubmit',
          hook_name: 'trace_prompt.py',
          command: 'python3 .claude/hooks/trace_prompt.py',
          outcome: 'success',
          exit_code: 0
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 80,
              cache_write_input_tokens: 7,
              output_tokens: 11,
              reasoning_output_tokens: 3
            }
          }
        }
      },
      {
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'codex-turn-1', last_agent_message: '完成' }
      }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'run workflow', turn_id: 'codex-turn-1', rollout_path: rollout })
    })
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
    expect(record.skills.value).toEqual([
      expect.objectContaining({ name: 'rate-workflow' })
    ])
    expect(record.hooks.value).toEqual([
      expect.objectContaining({ id: 'hook-1', event: 'UserPromptSubmit', status: 'success' })
    ])
    expect(record.usage).toMatchObject({
      status: 'available',
      quality: 'exact',
      value: {
        inputTokens: 120,
        outputTokens: 11,
        cacheReadTokens: 80,
        cacheCreationTokens: 7,
        reasoningTokens: 3
      }
    })
    expect(record.assistant.value?.text).toBe('先检查完成')
    expect(record.modelSegments?.value).toEqual([
      expect.objectContaining({ order: 0, kind: 'text', text: '先检查' }),
      expect.objectContaining({ order: 1, kind: 'thinking', text: '定位文件', messageId: 'reasoning-1' }),
      expect.objectContaining({ order: 5, kind: 'text', text: '完成' })
    ])
  })

  it('真实 Stop 早于 task_complete 时按完整 rollout 去重，并恢复 namespace、逐项错误、skill 与 usage', async () => {
    const root = await workspace()
    const rollout = join(root, 'early-stop-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'early-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: `const calls = [
  ["mcporter call coop.query --args '{}'", "mcp"],
  ["sed -n '1,20p' /opt/codex/plugins/chrome/skills/control-chrome/SKILL.md", "skill"]
];
const rs = await Promise.all(calls.map(([cmd]) => tools.exec_command({ cmd })));
rs.forEach((r, i) => text(\`RESULT \${i + 1}\\n\${JSON.stringify(r)}\`));`
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec',
          output: [
            { type: 'input_text', text: 'RESULT 1\n{"exit_code":0,"output":"ok"}' },
            { type: 'input_text', text: 'RESULT 2\n{"exit_code":2,"output":"missing"}' }
          ]
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'js',
          namespace: 'mcp__node_repl',
          call_id: 'call_js',
          arguments: '{"code":"nodeRepl.write(true)"}'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.400Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_js', output: 'true' }
      },
      {
        timestamp: '2026-07-19T12:00:00.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 250,
              cached_input_tokens: 200,
              cache_write_input_tokens: 0,
              output_tokens: 25,
              reasoning_output_tokens: 5
            },
            last_token_usage: {
              input_tokens: 250,
              cached_input_tokens: 200,
              cache_write_input_tokens: 0,
              output_tokens: 25,
              reasoning_output_tokens: 5
            }
          }
        }
      }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('early-session', { prompt: 'inspect', turn_id: 'early-turn', rollout_path: rollout })
    })
    for (const [index, timestamp] of ['2026-07-19T12:00:00.110Z', '2026-07-19T12:00:00.120Z', '2026-07-19T12:00:00.310Z'].entries()) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('early-session', {
          timestamp,
          turn_id: 'early-turn',
          tool_name: 'Bash',
          tool_use_id: `exec-${index + 1}`,
          tool_input: {}
        })
      })
      await handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('early-session', {
          timestamp,
          turn_id: 'early-turn',
          tool_name: 'Bash',
          tool_use_id: `exec-${index + 1}`,
          tool_response: 'ok'
        })
      })
    }
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('early-session', {
        turn_id: 'early-turn',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:00.600Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ name: 'Bash', status: 'failed' })
    ])
    expect(record.mcps.value).toEqual([
      expect.objectContaining({ mcp: expect.objectContaining({ server: 'coop', action: 'query' }) }),
      expect.objectContaining({ mcp: expect.objectContaining({ server: 'node_repl', action: 'js' }) })
    ])
    expect(record.skills.value).toEqual([
      expect.objectContaining({ name: 'control-chrome' })
    ])
    expect(record.errors.value).toHaveLength(1)
    expect(record.usage.value).toMatchObject({
      inputTokens: 250,
      outputTokens: 25,
      cacheReadTokens: 200,
      reasoningTokens: 5
    })
  })

  it('把异步 code-mode 的 wait 输出关联回原始逻辑调用', async () => {
    const root = await workspace()
    const rollout = join(root, 'async-code-mode-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'async-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect async' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: `const cmds = ["printf ok", "jq broken"];
const rs = await Promise.all(cmds.map(cmd => tools.exec_command({ cmd })));
rs.forEach((r, i) => text(\`R\${i + 1}\\n\${r.output}\`));`
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec',
          output: 'Script running with cell ID 44\nWall time 11.0 seconds\nOutput:\n'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait',
          arguments: '{"cell_id":"44","yield_time_ms":30000}'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.400Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
            { type: 'input_text', text: 'R1\nok' },
            { type: 'input_text', text: 'R2\njq: error (at input.json:1): broken query' }
          ]
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 10,
              cache_write_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 1
            }
          }
        }
      },
      { timestamp: '2026-07-19T12:00:00.600Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'async-turn' } }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('async-session', { prompt: 'inspect async', turn_id: 'async-turn', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('async-session', { turn_id: 'async-turn', rollout_path: rollout })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ status: 'success', outputSummary: 'ok' }),
      expect.objectContaining({ status: 'failed', outputSummary: 'jq: error (at input.json:1): broken query' })
    ])
    expect(record.errors.value).toEqual([
      expect.objectContaining({ message: 'jq: error (at input.json:1): broken query' })
    ])
  })

  it('超过 2 GiB 的稀疏 rollout 只读取当前轮窗口，不整体载入文件', async () => {
    const root = await workspace()
    const rollout = join(root, 'large-rollout.jsonl')
    const sparseSize = 2 * 1024 * 1024 * 1024 + 1024
    const handle = await openFile(rollout, 'w')
    try {
      await handle.truncate(sparseSize)
      await handle.write('\n', sparseSize - 1)
    } finally {
      await handle.close()
    }
    const line = (timestamp: string, type: string, value: Record<string, unknown>): string =>
      JSON.stringify({ timestamp, type, payload: value })
    await appendFile(rollout, `${[
      line('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'large-turn' }),
      line('2026-07-19T12:00:00.010Z', 'event_msg', { type: 'user_message', message: 'large transcript' })
    ].join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('large-session', {
        prompt: 'large transcript',
        turn_id: 'large-turn',
        rollout_path: rollout
      })
    })
    await appendFile(rollout, `${[
      line('2026-07-19T12:00:00.100Z', 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'large-call',
        arguments: JSON.stringify({ cmd: 'printf ok' })
      }),
      line('2026-07-19T12:00:00.200Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'large-call',
        output: 'ok'
      }),
      line('2026-07-19T12:00:01.000Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'large-turn',
        last_agent_message: 'done'
      })
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('large-session', {
        turn_id: 'large-turn',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record).toMatchObject({ sessionId: 'large-session', providerTurnId: 'large-turn', status: 'completed' })
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'large-call', name: 'Bash', status: 'success' })
    ])
  }, 15_000)

  it('还原 slash prompt、展开 Codex exec，并把子 agent 调用并入父轮但不重复 usage', async () => {
    const root = await workspace()
    const parent = join(root, 'rollout-parent.jsonl')
    const childId = '019fa774-618b-75b3-aed1-7f1dd8eb02f2'
    const child = join(root, `rollout-child-${childId}.jsonl`)
    const row = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
    const parentLines = [
      row('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'parent-turn' }),
      row('2026-07-19T12:00:00.010Z', 'event_msg', { type: 'user_message', message: '84441877' }),
      row('2026-07-19T12:00:00.020Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<skill><name>rate-workflow</name></skill>' }]
      }),
      row('2026-07-19T12:00:00.100Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'exec-1',
        input: `const a = await tools.exec_command({"cmd":"printf ok && sed -n '1,40p' .claude/skills/rate-workflow/SKILL.md /Users/test/.claude/skills/browser-use/SKILL.md"}); const b = await tools.exec_command({"cmd":"mcporter call coop.query --args '{}'"});`
      }),
      row('2026-07-19T12:00:00.200Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'exec-1',
        output: 'ok'
      }),
      row('2026-07-19T12:00:00.250Z', 'response_item', {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'agent-1',
        arguments: JSON.stringify({ task_name: 'review', message: 'review it' })
      }),
      row('2026-07-19T12:00:00.260Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'exec-map',
        input: `const cmds = ["printf one", "printf two"]; const rs = await Promise.all(cmds.map(cmd => tools.exec_command({cmd,workdir:"/repo",yield_time_ms:10000})));`
      }),
      row('2026-07-19T12:00:00.270Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'exec-map',
        output: 'one\ntwo'
      }),
      row('2026-07-19T12:00:00.300Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        event_id: 'agent-1',
        agent_thread_id: childId,
        agent_path: '/root/review'
      }),
      row('2026-07-19T12:00:00.310Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'patch-1',
        input: '*** Begin Patch\n*** Add File: /repo/new.txt\n+new\n*** End Patch\n'
      }),
      row('2026-07-19T12:00:00.320Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'patch-1',
        output: 'Done!'
      }),
      row('2026-07-19T12:00:00.330Z', 'event_msg', {
        type: 'patch_apply_end',
        call_id: 'patch-1',
        turn_id: 'parent-turn',
        changes: ['/repo/new.txt']
      }),
      row('2026-07-19T12:00:00.900Z', 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            cached_input_tokens: 80,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 5
          }
        }
      }),
      row('2026-07-19T12:00:01.000Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'parent-turn',
        last_agent_message: 'done'
      })
    ]
    const childLines = [
      row('2026-07-19T12:00:00.310Z', 'event_msg', { type: 'task_started', turn_id: 'child-turn' }),
      row('2026-07-19T12:00:00.400Z', 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'child-bash',
        arguments: JSON.stringify({ cmd: 'git status --short' })
      }),
      row('2026-07-19T12:00:00.500Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'child-bash',
        output: 'clean'
      }),
      row('2026-07-19T12:00:00.600Z', 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 900,
            output_tokens: 90,
            cached_input_tokens: 700,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 10
          }
        }
      }),
      row('2026-07-19T12:00:00.700Z', 'event_msg', { type: 'task_complete', turn_id: 'child-turn' })
    ]
    await writeFile(parent, `${parentLines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    await writeFile(child, `${childLines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: '84441877', turn_id: 'parent-turn', rollout_path: parent })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'parent-turn', rollout_path: parent, timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.user.value?.text).toBe('/rate-workflow 84441877')
    expect(record.tools.value?.map((call) => [call.name, call.id])).toEqual([
      ['Bash', 'exec-1:1'],
      ['review', 'agent-1'],
      ['Bash', 'exec-map:1'],
      ['Bash', 'exec-map:2'],
      ['Edit', 'patch-1'],
      ['Bash', 'child-bash']
    ])
    expect(record.mcps.value).toEqual([
      expect.objectContaining({ id: 'exec-1:2', name: 'Bash', mcp: expect.objectContaining({ server: 'coop', action: 'query' }) })
    ])
    expect(record.skills.value?.map((call) => call.name)).toEqual(['rate-workflow', 'browser-use'])
    expect(record.files.value).toEqual([{ path: '/repo/new.txt', operation: 'edit' }])
    expect(record.usage.value).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 5 })
  })

  it('未知 transcript 格式无法匹配指定 turn 时保持 pending，不伪造或借用记录', async () => {
    const root = await workspace()
    const transcript = join(root, 'unknown.jsonl')
    await writeFile(transcript, '{"type":"unknown"}\n')
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'unknown', turn_id: 'unknown-turn', rollout_path: transcript })
    })
    const completed = await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'unknown-turn', rollout_path: transcript })
    })

    expect(completed).toMatchObject({
      status: 'pending',
      reason: 'target turn is not present in transcript snapshot'
    })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
  })

  it('token_count 使用累计值做轮间差分，不重复累计 last_token_usage', async () => {
    const root = await workspace()
    const rollout = join(root, 'cumulative-rollout.jsonl')
    const line = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
    const token = (input: number, output: number, cache: number) => ({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: cache,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 0
        },
        // Deliberately repeated/noisy; authoritative per-turn usage comes from cumulative deltas.
        last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache }
      }
    })
    const lines = [
      line('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 't1' }),
      line('2026-07-19T12:00:00.100Z', 'event_msg', token(100, 10, 80)),
      line('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_complete', turn_id: 't1' }),
      line('2026-07-19T12:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 't2' }),
      line('2026-07-19T12:00:02.100Z', 'event_msg', token(250, 25, 200))
    ]
    await writeFile(rollout, `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`)

    for (const [turnId, start, end] of [
      ['t1', '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:01.000Z'],
      ['t2', '2026-07-19T12:00:02.000Z', '2026-07-19T12:00:03.000Z']
    ]) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'turn.started',
        workspace: root,
        payload: payload('c1', { prompt: turnId, turn_id: turnId, rollout_path: rollout, timestamp: start })
      })
      await handleRecorderHook({
        provider: 'codex',
        event: 'turn/completed',
        workspace: root,
        payload: payload('c1', { turn_id: turnId, rollout_path: rollout, timestamp: end })
      })
    }

    expect((await listRecords(join(root, '.scry'))).map((record) => record.usage.value)).toEqual([
      expect.objectContaining({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 }),
      expect.objectContaining({ inputTokens: 150, outputTokens: 15, cacheReadTokens: 120 })
    ])
  })
})

describe('record store cursor and recovery semantics', () => {
  it('records 作为 durable outbox，只向 callback 发送无敏感字段的提交通知', async () => {
    const root = await workspace()
    await completeTurn(root, 'notify-safe', 'do not leak this prompt')
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 1, pending: 0 })
    const notification = JSON.parse((await readFile(hook.capture, 'utf8')).trim()) as Record<string, unknown>
    expect(notification).toEqual({
      schemaVersion: 1,
      event: 'record-committed',
      workspace: root,
      provider: 'claude',
      sessionId: 'notify-safe',
      recordId: expect.any(String),
      sequence: 1
    })
    expect(JSON.stringify(notification)).not.toContain('do not leak this prompt')
    await expect(readFile(join(root, '.scry', 'notifications', 'commit-hook-state.json'), 'utf8'))
      .resolves.toContain('"ackedThrough":1')
  })

  it('callback 失败时保留未 ACK sequence，成功重试后推进 ACK', async () => {
    const root = await workspace()
    await completeTurn(root, 'notify-retry')
    const failed = await commitHook(root, 1)
    const base = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: failed.path }

    await expect(drainCommitNotifications(join(root, '.scry'), base))
      .resolves.toEqual({ delivered: 0, pending: 1 })
    await expect(access(join(root, '.scry', 'notifications', 'commit-hook-state.json'))).rejects.toThrow()
    const hook = await commitHook(root)
    await expect(drainCommitNotifications(join(root, '.scry'), {
      ...base,
      SCRY_RECORDER_COMMIT_HOOK: hook.path
    })).resolves.toEqual({ delivered: 1, pending: 0 })
    await expect(readFile(join(root, '.scry', 'notifications', 'commit-hook-state.json'), 'utf8'))
      .resolves.toContain('"ackedThrough":1')
  })

  it('duplicate commit 只重试既有未 ACK 通知，不创建第二条 sequence', async () => {
    const root = await workspace()
    await completeTurn(root, 'notify-duplicate')
    const [record] = await listRecords(join(root, '.scry'))
    const { sequence: _sequence, ...draft } = record
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await expect(commitRecord(join(root, '.scry'), draft)).resolves.toMatchObject({ status: 'duplicate', record: { sequence: 1 } })
    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 1, pending: 0 })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 0, pending: 0 })
  })

  it('冷启动只重投最新正式 record，不改写已推进的 ACK', async () => {
    const root = await workspace()
    await completeTurn(root, 'redeliver-1')
    await completeTurn(root, 'redeliver-2')
    const hook = await commitHook(root)
    const env = {
      ...process.env,
      SCRY_RECORDER_COMMIT_HOOK: hook.path,
      SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT: 'redelivery-test-v1'
    }
    await expect(drainCommitNotifications(join(root, '.scry'), env)).resolves.toEqual({ delivered: 2, pending: 0 })
    const statePath = join(root, '.scry', 'notifications', 'commit-hook-state.json')
    const before = await readFile(statePath, 'utf8')
    await writeFile(hook.capture, '')

    await expect(redeliverLatestCommitNotification(join(root, '.scry'), env)).resolves.toMatchObject({
      delivered: true,
      sequence: 2
    })
    const notifications = (await readFile(hook.capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(notifications).toEqual([expect.objectContaining({ sessionId: 'redeliver-2', sequence: 2 })])
    expect(await readFile(statePath, 'utf8')).toBe(before)
  })

  it('recover 强制收敛 closing 运行态，不把它无限保留为 pending', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('recover-me', { prompt: 'recover' })
    })
    const open = join(root, '.scry', 'runtime', 'claude', safeKey('recover-me'), 'open.json')
    const state = JSON.parse(await readFile(open, 'utf8')) as Record<string, unknown>
    await writeFile(open, JSON.stringify({
      ...state,
      status: 'closing',
      closingAt: '2026-07-19T12:00:01.000Z'
    }))

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toMatchObject([
      { sessionId: 'recover-me', status: 'completed' }
    ])
    await expect(readHealth(join(root, '.scry'))).resolves.toMatchObject({ pendingCount: 0 })
  })

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

describe('OpenCode compact lifecycle evidence', () => {
  it('把 session.next.compaction.ended 写进 CLI Turn Record', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'opencode',
      event: 'chat.message',
      workspace: root,
      payload: payload('o1', { prompt: 'continue' })
    })
    await handleRecorderHook({
      provider: 'opencode',
      event: 'session.next.compaction.ended',
      workspace: root,
      payload: payload('o1', {
        messageID: 'compact-message-1',
        reason: 'auto',
        timestamp: '2026-07-19T12:00:00.500Z'
      })
    })
    await handleRecorderHook({
      provider: 'opencode',
      event: 'session.idle',
      workspace: root,
      payload: payload('o1', { timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.compactions?.value).toEqual([
      expect.objectContaining({ trigger: 'auto' })
    ])
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
  }, 35_000)

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
  }, 35_000)
})
