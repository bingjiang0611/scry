import { setImmediate } from 'node:timers/promises'
import type { Transport } from '@qoder-ai/qoder-agent-sdk'
import { expect, it, vi } from 'vitest'
import type { BackgroundWork } from '../../shared/background-work'

const fixture = vi.hoisted(() => ({ transport: undefined as Transport | undefined }))
vi.mock('@qoder-ai/qoder-agent-sdk', async (original) => {
  const sdk = await original<typeof import('@qoder-ai/qoder-agent-sdk')>()
  return {
    ...sdk,
    ProcessTransport: class { constructor() { return fixture.transport! } },
    getSessionMessages: async () => []
  }
})
vi.mock('../claude-locate', () => ({ resolveRuntimeCliBin: () => '/unused/qodercli', runtimeCliEnv: () => ({}), shellEnv: () => ({}) }))
import { createQoderAdapter } from './qoder'
type Frame = ReturnType<Transport['readMessages']> extends AsyncGenerator<infer T> ? T : never

it('keeps real SDK stdin open and stops only the selected task, awaiting notifications before settling', async () => {
  const queue: Frame[] = []
  let closed = false
  let inputEnded = false
  let wake = (): void => {}
  const send = (value: unknown): void => { queue.push(value as Frame); wake() }
  const stops: string[] = []
  let work: BackgroundWork | undefined
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => { ready = resolve })
  fixture.transport = {
    initialize: async () => {}, isReady: () => !closed,
    write(line) {
      if (inputEnded) throw new Error('stdin closed before tasks ended')
      const frame = JSON.parse(line)
      if (frame.type === 'control_request') {
        if (frame.request.subtype === 'stop_task') stops.push(frame.request.task_id)
        send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } })
      } else if (frame.type === 'user') {
        send({ type: 'system', subtype: 'init', qodercli_version: '1.1.45', session_id: 'fixture-session', mcp_servers: [] })
        for (const id of ['a', 'b']) {
          send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command: 'fixture-only' } }] } })
          send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] }, tool_use_result: { kind: 'backgrounded', taskId: `task-${id}` } })
        }
        send({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Waiting for background tasks' }] } })
      }
    },
    async *readMessages() {
      while (!closed) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    endInput() { inputEnded = true; this.close() },
    close() { closed = true; wake() }
  }
  const run = createQoderAdapter().run({
    runId: 'task-control-wire', prompt: 'fixture only', attachments: [],
    emit(event) { if (event.backgroundWork) { work = event.backgroundWork; if (work.phase === 'waiting') ready() } }
  })
  try {
    await waiting
    expect(work).toMatchObject({ phase: 'waiting', taskStop: 'available' })
    expect(inputEnded).toBe(false)
    expect(await run.stopBackgroundTask!('not-observed')).toMatchObject({ status: 'rejected' })
    expect(await run.stopBackgroundTask!('task-a')).toMatchObject({ status: 'requested' })
    expect(await run.stopBackgroundTask!('task-a')).toMatchObject({ status: 'rejected' })
    expect(stops).toEqual(['task-a'])
    expect(work!.tasks).toHaveLength(2)
    expect(work!.tasks[0].stopState).toBe('requested')
    expect(inputEnded).toBe(false)
    send({ type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'a', status: 'stopped' })
    send({ type: 'result', subtype: 'success' })
    await setImmediate()
    expect(work!.tasks.map((task) => task.taskId)).toEqual(['task-b'])
    expect(inputEnded).toBe(false)
    send({ type: 'system', subtype: 'task_notification', task_id: 'task-b', tool_use_id: 'b', status: 'completed' })
    send({ type: 'result', subtype: 'success' })
    await expect(run.promise).resolves.toMatchObject({ status: 'completed' })
    expect(inputEnded).toBe(true)
    expect(work!.phase).toBe('inactive')
  } finally {
    fixture.transport.close()
    await run.promise.catch(() => {})
  }
})
