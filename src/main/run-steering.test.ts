import { describe, expect, it, vi } from 'vitest'
import type { AgentInputAttachment, AgentSteerInput, AgentSteerResult, AgentSteerRequest } from '../shared/runtime'
import type { ActiveRun, TraceEvent } from '../shared/trace'
import { RunSteering, steerObservedRun } from './run-steering'

const input: AgentSteerInput = { messageId: 'message-1', prompt: '先出设计稿', attachments: [] }
const request: AgentSteerRequest = {
  ...input, runId: 'run-1', providerId: 'codex', cwd: '/repo', expectedExternalSessionId: 'session-1'
}

function fixture() {
  const state: ActiveRun = {
    runId: 'run-1', providerId: 'codex', cwd: '/repo', externalSessionId: 'session-1',
    userText: 'original task', done: false,
    items: [{ id: 'capability', ts: '2026-10-11T00:00:00Z', runId: 'run-1', kind: 'harness', stage: 'runtime:steer_capability', steerCapability: { status: 'available', attachments: true } }]
  }
  const native = vi.fn<(input: AgentSteerInput) => Promise<AgentSteerResult>>().mockResolvedValue({ status: 'accepted', providerTurnId: 'turn-1' })
  const prepare = vi.fn((input: AgentSteerInput) => input.attachments)
  const emit = vi.fn((event: TraceEvent) => { state.items.push(event) })
  const steering = new RunSteering(state, () => native, prepare, emit)
  const lookup = vi.fn((runId: string) => runId === state.runId ? { state, control: { steer: (input: AgentSteerInput) => steering.submit(input) } } : undefined)
  return { state, native, prepare, emit, steering, lookup }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('native Steer admission ownership', () => {
  it('records native admission without changing the root prompt, run or turn lifecycle', async () => {
    const { native, state, emit, steering } = fixture()
    expect(await steering.submit(input)).toEqual({ status: 'accepted', providerTurnId: 'turn-1' })
    expect(native).toHaveBeenCalledWith(input)
    expect(emit.mock.calls.map(([event]) => event.steer?.status)).toEqual(['pending', 'accepted'])
    expect(state).toMatchObject({ userText: 'original task', runId: 'run-1', done: false })
  })

  it('deduplicates pending and accepted message identities, refuses changed contents', async () => {
    const { native, steering } = fixture()
    const pending = deferred<AgentSteerResult>()
    native.mockReturnValue(pending.promise)
    const first = steering.submit(input)
    const duplicate = steering.submit({ ...input })
    expect(first).toBe(duplicate)
    expect(await steering.submit({ ...input, prompt: 'different content' })).toMatchObject({ status: 'rejected' })
    pending.resolve({ status: 'accepted' })
    await first
    expect(await steering.submit(input)).toEqual({ status: 'accepted' })
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('quarantines transport uncertainty and never redispatches the same identity', async () => {
    const { native, emit, steering } = fixture()
    native.mockRejectedValue(new Error('transport closed after write'))
    expect(await steering.submit(input)).toMatchObject({ status: 'unknown' })
    expect(await steering.submit(input)).toMatchObject({ status: 'unknown' })
    expect(native).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls.at(-1)?.[0].steer).toMatchObject({ prompt: input.prompt, status: 'unknown' })
  })

  it('allows an explicit rejection to be retried without recreating its attachment files', async () => {
    const { native, prepare, steering } = fixture()
    const attachment: AgentInputAttachment = { kind: 'image', name: 'screen.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }
    const message = { ...input, attachments: [attachment] }
    native.mockResolvedValueOnce({ status: 'rejected', message: 'native refused' }).mockResolvedValueOnce({ status: 'accepted' })
    expect(await steering.submit(message)).toMatchObject({ status: 'rejected' })
    expect(await steering.submit(message)).toMatchObject({ status: 'accepted' })
    expect(native).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[1][0].attachments).toEqual([attachment])
  })

  it('does not issue a second native admission while an earlier one is pending', async () => {
    const { native, steering } = fixture()
    const pending = deferred<AgentSteerResult>()
    native.mockReturnValue(pending.promise)
    const first = steering.submit(input)
    expect(await steering.submit({ ...input, messageId: 'message-2' })).toMatchObject({ status: 'rejected' })
    pending.resolve({ status: 'accepted' })
    await first
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('keeps finalization waiting until the last admission outcome is recorded', async () => {
    const { native, steering, emit } = fixture()
    const pending = deferred<AgentSteerResult>()
    native.mockReturnValue(pending.promise)
    const admission = steering.submit(input)
    await Promise.resolve()
    steering.close()
    let finalized = false
    const idle = steering.idle().then(() => { finalized = true })
    await Promise.resolve()
    expect(finalized).toBe(false)
    expect(await steering.submit({ ...input, messageId: 'message-2' })).toMatchObject({ status: 'rejected' })
    pending.resolve({ status: 'unknown', message: 'native completion raced admission' })
    await admission
    await idle
    expect(emit.mock.calls.at(-1)?.[0].steer?.status).toBe('unknown')
    expect(finalized).toBe(true)
  })

  it('rechecks task completion before the deferred dispatch or any image write', async () => {
    const { state, native, prepare, steering } = fixture()
    const result = steering.submit(input)
    state.done = true
    expect(await result).toMatchObject({ status: 'rejected' })
    expect(native).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('does not silently drop images or claim support without active capability evidence', async () => {
    const { state, native, prepare, steering } = fixture()
    state.items[0].steerCapability = { status: 'available', attachments: false }
    expect(await steering.submit({ ...input, attachments: [{ kind: 'image', name: 'x', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }] })).toMatchObject({ status: 'unavailable' })
    state.items = []
    expect(await steering.submit(input)).toMatchObject({ status: 'unavailable' })
    expect(native).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('reports a definite local image preparation failure without invoking native Steer', async () => {
    const { native, prepare, steering } = fixture()
    prepare.mockImplementation(() => { throw new Error('bad image signature') })
    expect(await steering.submit(input)).toMatchObject({ status: 'rejected' })
    expect(native).not.toHaveBeenCalled()
  })
})

describe('trusted Steer request domain checks', () => {
  it.each([
    null, {}, { ...request, messageId: '../../outside' }, { ...request, prompt: 1 },
    { ...request, attachments: [{}] }, { ...request, providerId: 'invalid' },
    { ...request, expectedExternalSessionId: '' }
  ])('rejects invalid payload before looking up or touching a run', async payload => {
    const { lookup, native } = fixture()
    expect(await steerObservedRun(payload, lookup)).toMatchObject({ status: 'rejected' })
    expect(lookup).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  it.each([
    { runId: 'stale-run' }, { providerId: 'pi' }, { agentProfileId: 'pi:other' },
    { cwd: '/other-repo' }, { expectedExternalSessionId: 'other-session' }
  ])('rejects stale or cross-context identity before dispatch', async change => {
    const { lookup, native } = fixture()
    expect(await steerObservedRun({ ...request, ...change }, lookup)).toMatchObject({ status: 'rejected' })
    expect(native).not.toHaveBeenCalled()
  })

  it('strips renderer paths, preserves exact image bytes and admits only the authorized context', async () => {
    const { lookup, native } = fixture()
    const attachment = { kind: 'image', name: 'screen.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=', path: '/private/forged.png' }
    expect(await steerObservedRun({ ...request, attachments: [attachment] }, lookup)).toMatchObject({ status: 'accepted' })
    expect(native.mock.calls[0][0].attachments[0]).toMatchObject({ dataBase64: attachment.dataBase64 })
    expect(native.mock.calls[0][0].attachments[0]).not.toHaveProperty('path')
  })
})
