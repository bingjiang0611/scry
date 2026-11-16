import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace } from './fixture.test'
import {
  assistantText, launchReceipt, notification, notificationPrompt, sealQuietSegment, session, start, stop, toolUse, user
} from './state-machine-continuation-fixture'

/**
 * The verdict of a turn the next prompt supersedes.
 *
 * A turn that already reached its own Stop is finished work; only the prompt that closed it is
 * missing. A turn that never stopped was cut off. Both end up sealed by the same code path, so the
 * verdict has to come from the terminal this turn observed, not from whether a hold is currently
 * active — a background wake cancels the hold without un-stopping the turn.
 */
export function registerStopVerdictSuite(): void {
  it('收到 Stop 后被后台任务唤醒，下一轮提问仍在静默期内：上一轮记 completed', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-supersede-completed.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'run the build in the background', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 300'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Build started in the background.')
    ].join('\n')}\n`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'run the build in the background', '2026-07-19T12:00:00.000Z')
    })).resolves.toMatchObject({ status: 'started' })
    // The turn reaches its own Stop; the background task it launched is still reporting.
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    // The wake continues the same segment, and its own tool calls prove work is still going on.
    await appendFile(transcript, `\n${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Build finished; running the checks.')
    ].join('\n')}`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:40.000Z')
    })).resolves.toMatchObject({ reason: 'task notification continued the open turn' })
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'PreToolUse', workspace: root,
      payload: { ...start(transcript, 'request-2', 'x', '2026-07-19T12:00:41.000Z'), tool_name: 'Bash', tool_use_id: 'call-bg-2' }
    })).resolves.toMatchObject({ status: 'recorded' })
    // A real question arrives inside the silence window and supersedes the turn.
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-3', 'next question', '2026-07-19T12:00:50.000Z')
    })).resolves.toMatchObject({ status: 'started' })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ turnIndex: 1, status: 'completed' })
    expect(records[0].termination?.value).toMatchObject({ reason: 'provider_terminal' })
    expect(records[0].assistant.value?.text).toContain('Build finished; running the checks.')
  })

  it('收到 Stop 后没有唤醒，下一轮提问到达：上一轮记 completed', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-supersede-plain.jsonl')
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
    await appendFile(transcript, `\n${[
      user('prompt-2', 'second question', { requestSetId: 'request-2' }),
      assistantText('prompt-2', 'Second answer.')
    ].join('\n')}`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', 'second question', '2026-07-19T12:00:30.000Z')
    })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'completed' })
    expect(records[0].termination?.value).not.toMatchObject({ reason: 'superseded_by_next_turn' })
  })

  it('没收到 Stop 就被下一轮顶替：仍记 interrupted 并由下一轮提供边界', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-supersede-interrupted.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'start the long job', { requestSetId: 'request-1' }),
      assistantText('prompt-1', 'Working on it.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'start the long job', '2026-07-19T12:00:00.000Z')
    })
    // No Stop ever arrives for this turn.
    await appendFile(transcript, `\n${[
      user('prompt-2', 'never mind, do this instead', { requestSetId: 'request-2' }),
      assistantText('prompt-2', 'Switched.')
    ].join('\n')}`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', 'never mind, do this instead', '2026-07-19T12:00:30.000Z')
    })

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'interrupted' })
    expect(records[0].termination?.value).toMatchObject({ reason: 'superseded_by_next_turn' })
  })

  it('收到 Stop 后又被后台唤醒：唤醒仍接续同一段，不新开记录也不改判定', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder-supersede-wake.jsonl')
    await writeFile(transcript, `${[
      user('prompt-1', 'ship it', { requestSetId: 'request-1' }),
      toolUse('prompt-1', 'call-bg-1', 'sleep 300'),
      launchReceipt('call-bg-1', 'task-1'),
      assistantText('prompt-1', 'Release build started.')
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-1', 'ship it', '2026-07-19T12:00:00.000Z')
    })
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending', reason: expect.stringContaining('background task') })
    await appendFile(transcript, `\n${[
      notification('prompt-2', 'task-1', 'call-bg-1'),
      assistantText('prompt-2', 'Release published.')
    ].join('\n')}`)
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: start(transcript, 'request-2', notificationPrompt('task-1', 'call-bg-1'), '2026-07-19T12:00:40.000Z')
    })).resolves.toMatchObject({ status: 'recorded', reason: 'task notification continued the open turn' })
    // The wake's own Stop, then quiet: one segment, published as the completed turn.
    await expect(handleRecorderHook({ provider: 'qoder', event: 'Stop', workspace: root, payload: stop(transcript) }))
      .resolves.toMatchObject({ status: 'pending' })
    await sealQuietSegment(root)

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ turnIndex: 1, status: 'completed' })
    expect(records[0].turnRole).toBeUndefined()
    expect(records[0].assistant.value?.text).toContain('Release published.')
  })
}
