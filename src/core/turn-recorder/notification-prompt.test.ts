import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleRecorderHook } from './recorder.js'
import { isTaskNotificationPrompt } from './recorder-hook-support.js'
import { recorderOpenPath, recorderSessionRoot } from './runtime-state.js'
import { workspace } from './recorder-tests/fixture.test.js'

const block = (taskId = 'task-1') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`

describe('background notification prompts', () => {
  it('只把整条就是通知的消息认成唤醒，引用通知文本的提问仍然算提问', () => {
    expect(isTaskNotificationPrompt({ prompt: block() })).toBe(true)
    expect(isTaskNotificationPrompt({ prompt: `  ${block()}  \n` })).toBe(true)
    // Back-to-back notifications in one message are still only notifications.
    expect(isTaskNotificationPrompt({ prompt: `${block('a')}\n${block('b')}` })).toBe(true)
    // A person quoting a notification and then asking is asking.
    expect(isTaskNotificationPrompt({ prompt: `${block()}\n\n为什么它失败了？` })).toBe(false)
    expect(isTaskNotificationPrompt({ prompt: `这说明了什么？\n${block()}` })).toBe(false)
    expect(isTaskNotificationPrompt({ prompt: `${block()}谢谢` })).toBe(false)
    // An unterminated tag is not the Provider's notification.
    expect(isTaskNotificationPrompt({ prompt: '<task-notification>\n<task-id>task-1</task-id>' })).toBe(false)
    expect(isTaskNotificationPrompt({ prompt: '普通提问' })).toBe(false)
    // The Provider's own marker wins over the text: it never comes from a person.
    expect(isTaskNotificationPrompt({ prompt: 'why?', origin: { kind: 'task-notification' } })).toBe(true)
  })

  it('引用通知文本的提问仍开真实用户轮次，通知本身不成为 human prompt', async () => {
    const root = await workspace()
    const transcript = join(root, 'qoder.jsonl')
    const question = `${block()}\n\n为什么它失败了？`
    const row = (id: string, text: string) => JSON.stringify({
      type: 'user', timestamp: '2026-11-13T07:20:10.000Z', promptId: id,
      sessionId: 'qoder-quoted', message: { role: 'user', content: text }
    })
    await writeFile(transcript, `${[row('prompt-quoted', question), row('prompt-notification', block('task-2'))].join('\n')}\n`)

    // Transcript side: the person's text survives; the notification-only row is not a human prompt.
    const { parseTranscriptToTurns } = await import('../../main/normalize.js')
    const turns = parseTranscriptToTurns(`${[row('prompt-quoted', question), row('prompt-notification', block('task-2'))].join('\n')}\n`, {
      runId: 'run-quoted', newId: () => 'id', now: () => '2026-11-13T07:20:10.000Z'
    })
    expect(turns[0]?.userText).toBe(question)
    expect(turns.map(turn => turn.userText)).not.toContain(block('task-2'))

    // Hook side: the question opens a real user turn, not a continuation.
    await expect(handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: {
        session_id: 'qoder-quoted', cwd: root, transcript_path: transcript,
        request_set_id: 'prompt-quoted', prompt: question, hook_event_name: 'UserPromptSubmit',
        timestamp: '2026-11-13T07:20:00.000Z'
      }
    })).resolves.toMatchObject({ status: 'started' })
    const open = JSON.parse(await readFile(
      recorderOpenPath(recorderSessionRoot(join(root, '.scry'), 'qoder', 'qoder-quoted')), 'utf8'
    )) as { continuation?: unknown; prompt?: string }
    expect(open.continuation).toBeUndefined()
    expect(open.prompt).toBe(question)
  }, 20_000)
})
