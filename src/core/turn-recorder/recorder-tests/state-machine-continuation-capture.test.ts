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
 * 按会话开启的采集（CodeLens `capture start`）如何分段。
 *
 * 宿主声明一次采集，唤醒仍然属于同一个逻辑轮：接续记录必须关联回原始提问、复用同一份采集
 * 上下文，并且不重复正文。这组用例覆盖「采集声明」与「后台通知接续」的交叉点。
 */
export function registerContinuationCaptureSuite(): void {
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
    // One capture, one source: the wake continues the captured session instead of looking like a
    // second, unrelated recording of the same work.
    expect(records[1].capture).toEqual(records[0].capture)
    expect(records[1].capture).toMatchObject({ captureId: 'capture-1', source: 'manual', task: 'REQ-123' })
  })

  it('Qoder 后台通知按接续轮记：4 段 38/3/13/10 次调用合计 64 次不重不漏，通知文本不进 user.text', async () => {
    // Friday 复测现场：一次提问启动后台任务，被唤醒两次，最终 Stop 收尾。旧形状卡在
    // generation=2 / turnIndex=2 / closing，64 次工具调用只上传 38 次。
    const root = await workspace()
    const transcript = join(root, 'qoder-notification-shape.jsonl')
    const calls = (promptId: string, from: number, count: number): string[] =>
      Array.from({ length: count }, (_, index) => toolUse(promptId, `call-${from + index}`, `step ${from + index}`))
    const lastCall = (from: number, count: number) => `call-${from + count - 1}`

    await writeFile(transcript, `${[
      user('prompt-1', 'run the whole pipeline', { requestSetId: 'request-1' }),
      ...calls('prompt-1', 1, 37),
      toolUse('prompt-1', 'call-38', 'sleep 600'),
      launchReceipt('call-38', 'task-1'),
      assistantText('prompt-1', 'Pipeline is running in the background.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'run the whole pipeline', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    await sealQuietSegment(root)

    // First wake: task-1 reported, the Agent started the next background step and stopped again.
    await appendFile(transcript, `${[
      notification('prompt-2', 'task-1', 'call-38'),
      ...calls('prompt-2', 39, 2),
      toolUse('prompt-2', 'call-41', 'sleep 600'),
      launchReceipt('call-41', 'task-2'),
      assistantText('prompt-2', 'First stage finished; next stage started.')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-38'), '2026-07-19T12:05:41.000Z')
    })).resolves.toMatchObject({ status: 'started', reason: 'background wake continued a sealed turn' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    await sealQuietSegment(root)

    await appendFile(transcript, `${[
      notification('prompt-3', 'task-2', 'call-41'),
      ...calls('prompt-3', 42, 12),
      toolUse('prompt-3', 'call-54', 'sleep 600'),
      launchReceipt('call-54', 'task-3'),
      assistantText('prompt-3', 'Second stage finished; verification started.')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-3', notificationPrompt('task-2', 'call-41'), '2026-07-19T12:10:41.000Z')
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    await sealQuietSegment(root)

    // Third wake: the last background task reports and this segment really ends.
    await appendFile(transcript, `${[
      notification('prompt-4', 'task-3', 'call-54'),
      ...calls('prompt-4', 55, 10),
      assistantText('prompt-4', 'Verification finished; the pipeline is green.')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-4', notificationPrompt('task-3', 'call-54'), '2026-07-19T12:15:41.000Z')
    })).resolves.toMatchObject({ status: 'started' })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'committed' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((record) => record.turnIndex)).toEqual([1, 2, 3, 4])
    expect(records.map((record) => record.status)).toEqual(['completed', 'completed', 'completed', 'completed'])
    const counts = records.map((record) => record.tools.value?.length ?? 0)
    expect(counts).toEqual([38, 3, 13, 10])
    const ids = records.flatMap((record) => record.tools.value?.map((call) => call.id) ?? [])
    expect(ids).toHaveLength(64)
    expect(new Set(ids).size).toBe(64)
    // The question exists once; a notification is never promoted into user text.
    expect(records[0].user).toMatchObject({ status: 'available', value: { text: 'run the whole pipeline' } })
    for (const record of records) {
      expect(record.user.value?.text ?? '').not.toContain('<task-notification>')
      expect(record.user.value?.text ?? '').not.toContain('task-id')
    }
    for (const record of records.slice(1)) {
      expect(record.user.status).toBe('unavailable')
      expect(record.user.omissionReason).toContain('background task notification')
      expect(record.turnRole).toEqual({
        role: 'continuation', source: 'recorder_background_wake', parentId: records[0].recordId
      })
    }
    expect(await recoverRecorder(root)).toMatchObject({ recovered: 0, pending: 0 })
  })
}
