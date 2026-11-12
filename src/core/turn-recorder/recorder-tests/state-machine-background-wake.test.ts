import { appendFile, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder, CLOSING_TURN_EXPIRED_REASON } from '../recorder'
import { recorderOpenPath, recorderSessionRoot } from '../runtime-state'
import { listRecords } from '../store'
import { pendingBackgroundTasks } from '../recorder-transcript-background'
import { workspace } from './fixture.test'

/**
 * Qoder reports a finished background task as a new `UserPromptSubmit` that continues the turn that
 * stopped. The native transcript folds the notification into the same turn, so the turn keeps its
 * original prompt identity. These cases pin both halves: the turn must not be published at the Stop
 * that the wake later disproves, and a forced close must keep the body it already had.
 */
export function registerBackgroundWakeSuite(): void {
  const session = 'qoder-background-wake'

  const user = (promptId: string, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'user', timestamp: '2026-07-19T12:00:10.000Z', promptId,
    message: { role: 'user', content }, ...extra
  })
  const assistantText = (promptId: string, text: string, ts = '2026-07-19T12:00:11.000Z') => JSON.stringify({
    type: 'assistant', timestamp: ts, promptId, message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
  const toolUse = (promptId: string, id: string, name: string, input: Record<string, unknown>) => JSON.stringify({
    type: 'assistant', timestamp: '2026-07-19T12:00:12.000Z', promptId,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  })
  const toolResult = (id: string, content: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'user', timestamp: '2026-07-19T12:00:13.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra
  })
  const launchReceipt = (id: string, taskId: string) => toolResult(
    id, `Command running in background with ID: ${taskId}`,
    { toolUseResult: { kind: 'backgrounded', taskId } }
  )
  const notification = (promptId: string, taskId: string, toolUseId: string, status = 'completed') => JSON.stringify({
    type: 'user', timestamp: '2026-07-19T12:00:40.000Z', promptId, isMeta: true,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command completed</summary>\n</task-notification>`
    }
  })
  const notificationPrompt = (taskId: string, toolUseId: string, status = 'completed') =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command completed</summary>\n</task-notification>`

  /** Start identity only: the Stop hooks Qoder sends carry no timestamp of their own. */
  const start = (transcript: string, requestSetId: string, prompt: string, timestamp: string) => ({
    session_id: session, cwd: '/tmp', transcript_path: transcript,
    request_set_id: requestSetId, prompt, timestamp, hook_event_name: 'UserPromptSubmit'
  })
  const stop = (transcript: string) => ({
    session_id: session, cwd: '/tmp', transcript_path: transcript,
    stop_hook_active: false, hook_event_name: 'Stop',
    last_assistant_message: 'Background task is running. I will wait for it.'
  })

  it('Qoder 后台任务唤醒同一轮：Stop 不封箱，最后一次 Stop 才提交，最终只有一条完整记录', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-background.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'build the release notes', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg', 'Bash', { command: 'sleep 45', run_in_background: true }),
      launchReceipt('call-bg', 'task-1'),
      assistantText('prompt-1', 'Background task is running. I will wait for it.')
    ].join('\n')}\n`)

    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'build the release notes', '2026-07-19T12:00:00.000Z')
    })
    // The first Stop arrives while the background task is still outstanding: publishing here would
    // truncate the turn and turn the wake into a second record.
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })

    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg'),
      toolUse('prompt-2', 'call-verify', 'Bash', { command: 'npm run verify' }),
      toolResult('call-verify', 'verify ok'),
      assistantText('prompt-2', 'Release notes verified against the finished build.')
    ].join('\n')}\n`)

    // The wake is a `UserPromptSubmit` carrying a fresh request id, and must not start a turn.
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg'), '2026-07-19T12:00:41.000Z')
    })).resolves.toMatchObject({ status: 'recorded', reason: 'task notification continued the current turn' })

    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      turnIndex: 1,
      status: 'completed',
      user: { value: { text: 'build the release notes' } }
    })
    expect(records[0].tools.value?.map((call) => call.id)).toEqual(['call-bg', 'call-verify'])
    expect(records[0].assistant.value?.text).toContain('Release notes verified against the finished build.')
    expect(records[0].user.value?.text ?? '').not.toContain('<task-notification>')
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
  })

  it('Qoder 唤醒之后才出现新的 UserPromptSubmit：两轮边界正确，唤醒的工作留在第一轮', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-background-boundary.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'first request', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg', 'Agent', { description: 'inspect', run_in_background: true }),
      launchReceipt('call-bg', 'task-1'),
      assistantText('prompt-1', 'Waiting for the background agent.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'first request', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending' })

    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg'),
      assistantText('prompt-2', 'Background agent findings applied.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg'), '2026-07-19T12:00:41.000Z')
    })
    // The wake ends with its own Stop, and that one does close the turn.
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })

    // A real user prompt arrives after the extended turn ended.
    await appendFile(transcript, [
      user('prompt-3', 'second request', { requestSetId: 'request-3' }),
      assistantText('prompt-3', 'Second answer.')
    ].map((row) => `${row}\n`).join(''))
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-3', 'second request', '2026-07-19T12:01:00.000Z')
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.turnIndex, record.status, record.user.value?.text])).toEqual([
      [1, 'completed', 'first request'],
      [2, 'completed', 'second request']
    ])
    expect(records[0].assistant.value?.text).toContain('Background agent findings applied.')
  })

  it('普通单次 Stop 仍然在 Stop 时直接封箱', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-plain.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'answer briefly', { requestSetId: 'request-1' }),
      assistantText('prompt-1', 'Short answer.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'answer briefly', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'completed', user: { value: { text: 'answer briefly' } } })
  })

  it('强制封箱保留本轮正文并标记 partial，而不是丢弃', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-forced-window.jsonl')
    // The transcript keeps this turn's rows but never wrote its request id, so identity cannot match.
    await writeFile(transcript, `${[
      user('prompt-1', 'summarise the release'),
      assistantText('prompt-1', 'Release summary written before the identity was lost.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'summarise the release', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: 'target turn is not present in transcript snapshot' })

    await expect(handleRecorderHook({
      provider: 'qoder', event: 'SessionEnd', workspace: root,
      payload: { session_id: session, cwd: '/tmp', transcript_path: transcript, hook_event_name: 'SessionEnd' }
    })).resolves.toMatchObject({ status: 'pending' })
    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 1, pending: 0 })

    const [record] = await listRecords(join(root, '.scry'))
    // A session end is not a completion, but it is no longer a reason to drop the body either.
    expect(record).toMatchObject({ status: 'interrupted', user: { value: { text: 'summarise the release' } } })
    expect(record.assistant).toMatchObject({ status: 'partial', quality: 'inferred' })
    expect(record.assistant.value?.text).toContain('Release summary written before the identity was lost.')
    expect(record.assistant.omissionReason).toContain('bounded by the recorded turn start')
  })

  it('后台任务一直不回报时按关闭静默窗口强制封箱，仍保留正文', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-silent-background.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'run the long build', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg', 'Bash', { command: 'make release', run_in_background: true }),
      launchReceipt('call-bg', 'task-1'),
      assistantText('prompt-1', 'Build is running in the background.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'run the long build', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending' })
    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 0, pending: 1 })

    // Nothing moved for longer than the closing silence window: stop waiting for the task.
    const openPath = recorderOpenPath(recorderSessionRoot(join(root, '.scry'), 'qoder', session))
    const stale = new Date(Date.now() - 61 * 60 * 1_000)
    await utimes(openPath, stale, stale)
    await utimes(transcript, stale, stale)
    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 1, expired: 1 })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record).toMatchObject({ status: 'completed', user: { value: { text: 'run the long build' } } })
    // The Stop did arrive, so the verdict stays `completed`; only the evidence says why it stopped
    // converging.
    expect(record.termination.value.reason).toBe('provider_terminal')
    expect(record.assistant.value?.text).toContain('Build is running in the background.')
    expect(record.tools).toMatchObject({ status: 'partial' })
    expect(record.tools.omissionReason ?? '').toContain(CLOSING_TURN_EXPIRED_REASON)
    // The forced close never publishes work it cannot attribute.
    expect(record.diff.status).not.toBe('available')
    expect(CLOSING_TURN_EXPIRED_REASON).toContain('closing silence window')
  })

  it('只有结构化启动回执加未完成的完成通知才算待回报的后台任务', () => {
    const rows = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-bg', name: 'Bash', input: { run_in_background: true } }] } }),
      // Intent alone is not a launch: the Provider may have run it in the foreground.
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-bg', content: 'Command running in background with ID: task-1' }] } })
    ]
    expect(pendingBackgroundTasks(rows.join('\n'))).toEqual([])
    const launched = [...rows, JSON.stringify({ type: 'user', toolUseResult: { kind: 'backgrounded', taskId: 'task-1' }, message: { role: 'user', content: [] } })]
    expect(pendingBackgroundTasks(launched.join('\n'))).toEqual(['task-1'])
    // A progress notification is not a completion.
    const progress = [...launched, JSON.stringify({
      type: 'user', origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>call-bg</tool-use-id>\n<status>running</status>\n</task-notification>' }
    })]
    expect(pendingBackgroundTasks(progress.join('\n'))).toEqual(['task-1'])
    const settled = [...progress, JSON.stringify({
      type: 'user', isMeta: true, origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>call-bg</tool-use-id>\n<status>completed</status>\n</task-notification>' }
    })]
    expect(pendingBackgroundTasks(settled.join('\n'))).toEqual([])
    // Two launches and one completion leaves exactly the unreported task.
    const twoLaunches = [...settled, JSON.stringify({ type: 'user', toolUseResult: { kind: 'backgrounded', taskId: 'task-2' }, message: { role: 'user', content: [] } })]
    expect(pendingBackgroundTasks(twoLaunches.join('\n'))).toEqual(['task-2'])
  })
}
