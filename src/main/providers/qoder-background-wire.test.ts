import { setImmediate } from 'node:timers/promises'
import type { Transport } from '@qoder-ai/qoder-agent-sdk'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ transport: undefined as Transport | undefined }))
vi.mock('@qoder-ai/qoder-agent-sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@qoder-ai/qoder-agent-sdk')>()
  return {
    ...sdk,
    query: (args: Parameters<typeof sdk.query>[0]) => sdk.query({
      ...args,
      options: { ...args.options, transport: { create: () => fixture.transport! } }
    })
  }
})
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/unused/qodercli', runtimeCliEnv: () => ({}), shellEnv: () => ({})
}))

import { createQoderAdapter } from './qoder'

type WireMessage = ReturnType<Transport['readMessages']> extends AsyncGenerator<infer T> ? T : never

it('answers real SDK model-policy control requests after the first result while Bash is backgrounded', async () => {
  const queue: WireMessage[] = []
  let wake = (): void => {}
  let closed = false
  let inputEnded = false
  let finishPolicy!: () => void
  const policyAnswered = new Promise<void>((resolve) => { finishPolicy = resolve })
  let rootObserved!: () => void
  const root = new Promise<void>((resolve) => { rootObserved = resolve })
  const send = (message: Record<string, unknown>): void => {
    queue.push(message as WireMessage)
    wake()
  }
  fixture.transport = {
    async initialize() {},
    isReady: () => !closed,
    write(line) {
      if (inputEnded) throw new Error('Control response attempted after stdin EOF')
      const frame = JSON.parse(line)
      if (frame.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } })
      } else if (frame.type === 'user') {
        send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bash-1', input: { run_in_background: true } }] } })
        send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'launched' }] }, tool_use_result: { kind: 'backgrounded', taskId: 'shell-1' } })
        send({ type: 'result', subtype: 'success', result: 'started' })
      } else if (frame.type === 'control_response' && frame.response.request_id === 'policy-after-background') {
        expect(frame.response).toMatchObject({ subtype: 'success', response: { type: 'get_model_policy', model: 'ultimate' } })
        finishPolicy()
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
    runId: 'wire-background', prompt: 'fixture only', attachments: [],
    model: { id: 'ultimate' }, effort: 'high',
    emit: (event) => { if (event.stage === 'result') rootObserved() }
  })
  // Always tear down the in-memory query on assertion failure; no CLI, network,
  // real workspace, transcript, credentials or business writes are involved.
  try {
    await root
    await setImmediate()
    expect(inputEnded).toBe(false)
    send({ type: 'system', subtype: 'task_notification', task_id: 'shell-1', tool_use_id: 'bash-1', status: 'failed' })
    send({ type: 'control_request', request_id: 'policy-after-background', request: { subtype: 'get_model_policy', purpose: 'main', models: [] } })
    await policyAnswered
    expect(inputEnded).toBe(false)
    send({ type: 'result', subtype: 'success', result: 'failure notification handled' })
    await run.promise
    expect(inputEnded).toBe(true)
  } finally {
    fixture.transport.close()
    await run.promise.catch(() => {})
  }
})
