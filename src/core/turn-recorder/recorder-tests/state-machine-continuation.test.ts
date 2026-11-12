import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords } from '../store'
import { startSessionCapture } from '../session-capture'
import { workspace } from './fixture.test'
import {
  assistantText, captureHook, launchReceipt, notification, notificationPrompt, sealQuietSegment,
  session, start, stop, toolUse, user
} from './state-machine-continuation-fixture'

/**
 * Qoder continues one logical turn after its Stop when a background task reports: the wake arrives
 * as a `UserPromptSubmit` whose prompt is a `<task-notification>` and whose request id is new, while
 * the native transcript folds the row into the turn that stopped.
 *
 * These cases pin the segment model: every Stop is published once its segment goes quiet, a wake
 * inside that window belongs to the same segment, and a wake after the seal opens a continuation
 * segment that links back to the question instead of inventing a prompt nobody sent.
 */
export function registerContinuationSuite(): void {
  it('同一个提问之后多次 Stop，间隔超过静默窗口：每段一条记录，内容不重不漏且能关联回原提问', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-segments.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'ship the release', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 300'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Release build started in the background.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'ship the release', '2026-07-19T12:00:00.000Z')
    })
    // The Agent stops to wait for the background build; publishing here is fine once it is quiet.
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    await sealQuietSegment(root)
    const first = (await listRecords(join(root, '.scry')))[0]
    expect(first).toMatchObject({ turnIndex: 1, status: 'completed', user: { value: { text: 'ship the release' } } })

    // First wake: the build reported and the Agent kept working, but the segment was already sealed.
    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Build finished; running verification.'),
      toolUse('prompt-2', 'call-bg-2', 'sleep 300'),
      launchReceipt('call-bg-2', 'task-2')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z')
    })).resolves.toMatchObject({ status: 'started', reason: 'background wake continued a sealed turn' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    await sealQuietSegment(root)

    // Second wake after the second seal: another continuation of the same original question.
    await appendFile(transcript, `${[
      notification('prompt-3', 'task-2', 'call-bg-2'),
      assistantText('prompt-3', 'Verification finished; the release is out.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-3', notificationPrompt('task-2', 'call-bg-2'), '2026-07-19T12:00:42.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.turnIndex, record.status])).toEqual([[1, 'completed'], [2, 'completed'], [3, 'completed']])
    // The question is asked once; the segments after it say why they have no prompt.
    expect(records[0].user).toMatchObject({ status: 'available', value: { text: 'ship the release' } })
    for (const record of records.slice(1)) {
      expect(record.user.status).toBe('unavailable')
      expect(record.user.omissionReason).toContain('background task notification')
      expect(record.turnRoleStatus).toBe('observed')
      expect(record.turnRole).toEqual({
        role: 'continuation',
        source: 'recorder_background_wake',
        parentId: records[0].recordId
      })
    }
    // Each tool call and each assistant sentence belongs to exactly one record.
    expect(records.map((record) => record.tools.value?.map((call) => call.id) ?? [])).toEqual([
      ['call-bg-1'], ['call-bg-2'], []
    ])
    expect(records.map((record) => record.assistant.value?.text ?? '')).toEqual([
      'Release build started in the background.',
      'Build finished; running verification.',
      'Verification finished; the release is out.'
    ])
    // A continuation has no Git baseline of its own, so it must not claim one.
    expect(records[2].diff.status).toBe('unavailable')
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
  })

  it('间隔都在静默窗口内：合并为一段，只有一条记录', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-coalesced.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'run the checks', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 30'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Checks are running in the background.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'run the checks', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending' })

    // The wake arrives inside the silence window, so it extends this segment rather than opening one.
    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Checks passed.')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z')
    })).resolves.toMatchObject({ reason: 'task notification continued the open turn' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ turnIndex: 1, status: 'completed' })
    expect(records[0].turnRole).toBeUndefined()
    expect(records[0].assistant.value?.text).toContain('Checks passed.')
    expect(records[0].tools.value?.map((call) => call.id)).toEqual(['call-bg-1'])
  })

  it('唤醒之后出现新的 UserPromptSubmit：正常开新轮，边界正确', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-boundary.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'first request', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 30'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Waiting for the background check.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'first request', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending' })
    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Background check finished.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z')
    })

    // A real question ends the extended turn and starts its own.
    await appendFile(transcript, `${[
      user('prompt-3', 'second request', { requestSetId: 'request-3' }),
      assistantText('prompt-3', 'Second answer.')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-3', 'second request', '2026-07-19T12:01:00.000Z')
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => [record.turnIndex, record.user.value?.text])).toEqual([
      [1, 'first request'],
      [2, 'second request']
    ])
    expect(records[0].assistant.value?.text).toContain('Background check finished.')
    expect(records[0].turnRole).toBeUndefined()
    expect(records[0].user.value?.text ?? '').not.toContain('<task-notification>')
  })

  it('强制封箱保留本段正文并标记 partial', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-forced.jsonl')
    // The transcript kept this turn's rows but never wrote its request id, so identity cannot match.
    await writeFile(transcript, `${[
      user('prompt-1', 'summarise the release'),
      assistantText('prompt-1', 'Summary written before the identity was lost.')
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
    expect(record).toMatchObject({ status: 'interrupted', user: { value: { text: 'summarise the release' } } })
    expect(record.assistant).toMatchObject({ status: 'partial', quality: 'inferred' })
    expect(record.assistant.value?.text).toContain('Summary written before the identity was lost.')
    expect(record.assistant.omissionReason).toContain('bounded by the recorded turn start')
  })

  it('普通单次 Stop 仍在 Stop 时直接封箱，不延迟', async () => {
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
    expect(records[0].assistant.value?.text).toBe('Short answer.')
  })

  it('排队通知已收尾的后台任务不算未完成：Stop 立即封箱', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-queued.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'wait for the build', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 30'),
      launchReceipt('call-bg-1', 'task-1'),
      // Qoder also writes the completion as a queued attachment when the task ended while the Agent
      // was busy; that row is the only place the task id and its final status appear.
      JSON.stringify({
        type: 'attachment', timestamp: '2026-07-19T12:00:20.000Z',
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notificationPrompt('task-1', 'call-bg-1') }
      }),
      assistantText('prompt-1', 'The build finished while I was still writing.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'wait for the build', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].assistant.value?.text).toBe('The build finished while I was still writing.')
  })

  it('按会话开启模式下同样分段：唤醒后仍然只有一条接续记录且不重复正文', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-capture.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'run the captured task', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 30'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Captured task is running in the background.')
    ].join('\n')}\n`)
    // A capture claim opens the turn from the transcript it points at, not from a hook prompt.
    await expect(startSessionCapture({
      workspace: root,
      provider: 'qoder',
      sessionId: session,
      dataDir: join(root, '.scry'),
      context: {
        protocol: 'codelens.session-capture.v1', captureId: 'capture-1', sessionId: session,
        cwd: root, host: 'qoder', transcriptPath: transcript, openedAt: '2026-07-19T12:00:01.000Z',
        source: 'manual', task: 'REQ-123'
      },
      payload: {
        session_id: session, hook_event_name: 'PreToolUse', transcript_path: transcript,
        timestamp: '2026-07-19T12:00:01.000Z', tool_name: 'Bash',
        tool_input: { command: 'codelens scry capture start --task REQ-123' }
      },
      cli: {}
    })).resolves.toMatchObject({ status: 'started' })

    await expect(captureHook(root, 'Stop', stop(transcript)))
      .resolves.toMatchObject({ status: 'accepted', ack: { result: 'pending' } })
    await sealQuietSegment(root)

    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Captured task finished.')
    ].join('\n')}\n`)
    await expect(captureHook(root, 'UserPromptSubmit',
      start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:41.000Z')))
      .resolves.toMatchObject({ status: 'accepted', ack: { result: 'started' } })
    await expect(captureHook(root, 'Stop', stop(transcript)))
      .resolves.toMatchObject({ status: 'accepted', ack: { result: 'committed' } })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(2)
    expect(records[1].turnRole).toMatchObject({ role: 'continuation', parentId: records[0].recordId })
    expect(records[1].assistant.value?.text).toBe('Captured task finished.')
    expect(records[1].tools.value ?? []).toEqual([])
  })
}
