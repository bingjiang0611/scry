import type { Transport } from '@qoder-ai/qoder-agent-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { QoderTaskControlTransport } from './qoder-task-control'

type Frame = ReturnType<Transport['readMessages']> extends AsyncGenerator<infer T> ? T : never
function fixture(version = '1.1.45') {
  const queue: Frame[] = [{ type: 'system', subtype: 'init', qodercli_version: version } as Frame]
  let wake = (): void => {}
  let closed = false
  const write = vi.fn()
  const inner: Transport = {
    initialize: async () => {}, isReady: () => !closed, write, endInput: () => {},
    close: () => { closed = true; wake() },
    async *readMessages() {
      while (!closed) {
        if (queue.length) yield queue.shift()!
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    }
  }
  const transport = new QoderTaskControlTransport(inner)
  return { transport, write, send: (raw: unknown) => { queue.push(raw as Frame); wake() } }
}
afterEach(() => vi.useRealTimers())

it('uses only the version-gated stop_task wire and consumes only its own acknowledgments', async () => {
  const f = fixture()
  const reader = f.transport.readMessages()
  await reader.next()
  const pending = f.transport.stopTask('task-1')
  const request = JSON.parse(f.write.mock.calls[0][0])
  expect(request.request).toEqual({ subtype: 'stop_task', task_id: 'task-1' })
  f.send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success' } })
  f.send({ type: 'control_response', response: { request_id: 'sdk-control', subtype: 'success' } })
  expect((await reader.next()).value).toMatchObject({ response: { request_id: 'sdk-control' } })
  expect(await pending).toMatchObject({ status: 'requested' })
  f.transport.close()
  await reader.return()
})

it.each(['1.1.44', '1.2.0', 'unknown'])('does not send unverified stop controls to %s', async (version) => {
  const f = fixture(version)
  const reader = f.transport.readMessages()
  await reader.next()
  expect(await f.transport.stopTask('task-1')).toMatchObject({ status: 'unavailable' })
  expect(f.write).not.toHaveBeenCalled()
  f.transport.close()
  await reader.return()
})

it('does not borrow a child or replayed runtime version for task-stop capability', async () => {
  const f = fixture('unknown')
  const reader = f.transport.readMessages()
  await reader.next()
  for (const extra of [{ parent_tool_use_id: 'agent' }, { isReplay: true }]) {
    f.send({ type: 'system', subtype: 'init', qodercli_version: '1.1.45', ...extra })
    await reader.next()
    expect(f.transport.canStopTask).toBe(false)
  }
  expect(await f.transport.stopTask('task')).toMatchObject({ status: 'unavailable' })
  expect(f.write).not.toHaveBeenCalled()
  f.transport.close()
  await reader.return()
})

it('revokes control at stdin EOF even while stdout is still ready', async () => {
  const f = fixture()
  const reader = f.transport.readMessages()
  await reader.next()
  const pending = f.transport.stopTask('task-1')
  f.transport.endInput()
  expect(f.transport.canStopTask).toBe(false)
  expect(await pending).toMatchObject({ status: 'unknown' })
  expect(await f.transport.stopTask('task-2')).toMatchObject({ status: 'unavailable' })
  expect(f.write).toHaveBeenCalledOnce()
  f.transport.close()
  await reader.return()
})

it('does not treat a malformed correlated reply as an explicit rejection permitting retry', async () => {
  const f = fixture()
  const reader = f.transport.readMessages()
  await reader.next()
  const pending = f.transport.stopTask('task-1')
  const request = JSON.parse(f.write.mock.calls[0][0])
  f.send({ type: 'control_response', response: { request_id: request.request_id, subtype: 'unexpected' } })
  f.send({ type: 'system', subtype: 'heartbeat' })
  await reader.next()
  expect(await pending).toMatchObject({ status: 'unknown' })
  f.transport.close()
  await reader.return()
})

it('does not retain a verified version across a new root initialization without version evidence', async () => {
  const f = fixture()
  const reader = f.transport.readMessages()
  await reader.next()
  f.send({ type: 'system', subtype: 'init' })
  await reader.next()
  expect(f.transport.canStopTask).toBe(false)
  f.transport.close()
  await reader.return()
})

it('reports missing acknowledgments as unknown without replay and closes pending requests', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const reader = f.transport.readMessages()
  await reader.next()
  const request = f.transport.stopTask('task-1')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await request).toMatchObject({ status: 'unknown' })
  expect(f.write).toHaveBeenCalledOnce()
  const another = f.transport.stopTask('task-2')
  f.transport.close()
  expect(await another).toMatchObject({ status: 'unknown' })
  expect(vi.getTimerCount()).toBe(0)
  await reader.return()
})
