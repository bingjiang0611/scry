import { readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { recoverRecorder } from '../recorder'
import { recorderOpenPath, recorderSessionRoot } from '../runtime-state'
import { applySessionCaptureHook } from '../session-capture'

/**
 * The transcript rows and hook payloads of a Qoder turn that keeps working after its Stop: the native
 * transcript folds the wake into the interrupted turn while the next `UserPromptSubmit` arrives with
 * its own request id and a `<task-notification>` prompt.
 */
export const session = 'qoder-continuation'
/** The silence window a held Stop waits out before recovery publishes it. */
export const silence = 181_000

export const user = (promptId: string, content: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user', timestamp: '2026-07-19T12:00:10.000Z', promptId,
  message: { role: 'user', content }, ...extra
})
export const assistantText = (promptId: string, text: string, ts = '2026-07-19T12:00:11.000Z') => JSON.stringify({
  type: 'assistant', timestamp: ts, promptId, message: { role: 'assistant', content: [{ type: 'text', text }] }
})
export const toolUse = (promptId: string, id: string, command: string) => JSON.stringify({
  type: 'assistant', timestamp: '2026-07-19T12:00:12.000Z', promptId,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, run_in_background: true } }] }
})
export const launchReceipt = (id: string, taskId: string) => JSON.stringify({
  type: 'user', timestamp: '2026-07-19T12:00:13.000Z', toolUseResult: { kind: 'backgrounded', taskId },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${taskId}` }] }
})
export const notification = (promptId: string, taskId: string, toolUseId: string) => JSON.stringify({
  type: 'user', timestamp: '2026-07-19T12:00:40.000Z', promptId, isMeta: true,
  origin: { kind: 'task-notification' },
  message: { role: 'user', content: notificationPrompt(taskId, toolUseId) }
})
export const notificationPrompt = (taskId: string, toolUseId: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>`

export const start = (transcript: string, requestSetId: string, prompt: string, timestamp: string) => ({
  session_id: session, cwd: '/tmp', transcript_path: transcript,
  request_set_id: requestSetId, prompt, timestamp, hook_event_name: 'UserPromptSubmit'
})
// Real Qoder Stop hooks carry no timestamp of their own, only the request they terminate.
export const stop = (transcript: string) => ({
  session_id: session, cwd: '/tmp', transcript_path: transcript,
  stop_hook_active: false, hook_event_name: 'Stop'
})

/**
 * A captured session delivers its events through the capture path, not as ordinary Provider hooks:
 * everything it does is inside the claim, so a test must not depend on whether ordinary hooks are
 * enabled for that workspace.
 */
export const captureHook = async (root: string, event: string, payload: Record<string, unknown>) =>
  applySessionCaptureHook({
    workspace: root, provider: 'qoder', event, sessionId: session, dataDir: join(root, '.scry'), payload
  })

const openStatePath = (root: string) =>
  recorderOpenPath(recorderSessionRoot(join(root, '.scry'), 'qoder', session))

/** Recovery only seals a held Stop once the silence window has passed. */
export const sealQuietSegment = async (root: string): Promise<void> => {
  const path = openStatePath(root)
  const state = JSON.parse(await readFile(path, 'utf8')) as { deferredTerminalAt?: string }
  expect(state.deferredTerminalAt).toBeDefined()
  state.deferredTerminalAt = new Date(Date.now() - silence).toISOString()
  await writeFile(path, JSON.stringify(state))
  await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 1, pending: 0 })
}
