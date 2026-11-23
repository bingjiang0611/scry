import { describe, expect, it, vi } from 'vitest'
import { DAEMON_LOCAL_OP_CHANNELS } from '../daemon-channel-gate'
import { handleLocalOp, localOpCaller, localOpHandlersFor, type LocalOpHandler } from './host-local-ops'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import type { HostController } from './host-controller'

const PEER = 'b'.repeat(64)
const everyChannel = (handler: LocalOpHandler) =>
  Object.fromEntries(Object.keys(DAEMON_LOCAL_OP_CHANNELS).map((channel) => [channel, handler]))

describe('local ops on the App endpoint', () => {
  it('calls the handler main would run with the renderer arguments', async () => {
    const listSessions = vi.fn(() => [{ id: 's1' }])
    const handlers = localOpHandlersFor({ ...everyChannel(() => undefined), 'agent:listSessions': listSessions })
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', args: [{ providerId: 'codex', cwd: '/w' }] }, PEER))
      .resolves.toEqual({ result: [{ id: 's1' }] })
    expect(listSessions).toHaveBeenCalledWith({ providerId: 'codex', cwd: '/w' })
    // JSON has no undefined: a handler that returns nothing answers null.
    await expect(handleLocalOp(handlers, { op: 'projectStore', method: 'recentFolders' }, PEER)).resolves.toEqual({ result: null })
  })

  it('tells a handler which verified grant it serves, and nobody outside a call', async () => {
    // A conversation send records a ledger intent under its caller's grant; the local
    // endpoint may hold several grants, so "the App" is not an identity.
    const seen: Array<string | undefined> = []
    const handlers = localOpHandlersFor({ ...everyChannel(() => undefined), 'agent:listSessions': async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.push(localOpCaller())
    } })
    await Promise.all([
      handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', args: [] }, PEER),
      handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', args: [] }, 'c'.repeat(64))
    ])
    expect(seen.sort()).toEqual([PEER, 'c'.repeat(64)])
    expect(localOpCaller()).toBeUndefined()
  })

  it('gives the handler back the arguments the caller left out, exactly as main would', async () => {
    const read = vi.fn((...args: unknown[]) => args)
    const handlers = localOpHandlersFor({ ...everyChannel(() => undefined), 'conversation:read': read })
    // As the frame arrives: JSON already turned the omitted argument into null.
    await handleLocalOp(handlers, JSON.parse(JSON.stringify({ op: 'conversation', method: 'read', args: ['conv-1', undefined], absent: [1] })), PEER)
    expect(read).toHaveBeenLastCalledWith('conv-1', undefined)
    expect(read.mock.lastCall).toHaveLength(2)
    // Without the marker a null stays the caller's null.
    await handleLocalOp(handlers, { op: 'conversation', method: 'read', args: ['conv-1', null] }, PEER)
    expect(read).toHaveBeenLastCalledWith('conv-1', null)
    for (const absent of [[2], [-1], [1.5], [1, 1], 'x', [0, 1, 2, 3, 4]]) {
      await expect(handleLocalOp(handlers, { op: 'conversation', method: 'read', args: ['conv-1', null], absent }, PEER))
        .resolves.toEqual({ error: 'invalid_request' })
    }
  })

  it('refuses malformed requests and methods it does not serve', async () => {
    const handlers = localOpHandlersFor(everyChannel(() => 'ok'))
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', cwd: '/etc' }, PEER)).resolves.toEqual({ error: 'invalid_request' })
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', args: [1, 2, 3, 4, 5] }, PEER)).resolves.toEqual({ error: 'invalid_request' })
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'deleteEverything', args: [] }, PEER)).resolves.toEqual({ error: 'unsupported_op' })
  })

  it('fails assembly when a forwarded channel has no handler, instead of leaving a silent gap', () => {
    const partial = everyChannel(() => 'ok')
    delete partial['agent:detect']
    expect(() => localOpHandlersFor(partial)).toThrow('local_op_handler_missing:agent:detect')
  })

  it('answers unsupported_op on an endpoint without local handlers, such as the network endpoint', async () => {
    const controller = {} as HostController
    await expect(dispatchRemoteRequest(controller, 'a'.repeat(64), { protocol: 3, op: 'sessionStore', method: 'listSessions', args: [] }))
      .resolves.toEqual({ error: 'unsupported_op' })
    const handlers = localOpHandlersFor(everyChannel(() => 'ok'))
    await expect(dispatchRemoteRequest(controller, 'a'.repeat(64), { protocol: 3, op: 'sessionStore', method: 'listSessions', args: [] }, undefined, { localOps: handlers }))
      .resolves.toEqual({ result: 'ok' })
  })

  it('rejects the retired App event op on both endpoints', async () => {
    const controller = {} as HostController
    const peer = 'a'.repeat(64)
    const request = { protocol: 3, op: 'appEvents', cursor: 0, waitMs: 0 }
    await expect(dispatchRemoteRequest(controller, peer, request)).resolves.toEqual({ error: 'unknown_op' })
    await expect(dispatchRemoteRequest(controller, peer, request, undefined, {})).resolves.toEqual({ error: 'unknown_op' })
  })

  it('lets the App mark a daemon session viewed on the local endpoint only', async () => {
    const controller = {} as HostController
    const peer = 'a'.repeat(64)
    await expect(dispatchRemoteRequest(controller, peer, { protocol: 3, op: 'attentionViewed', sessionKey: 'k' }))
      .resolves.toEqual({ error: 'unsupported_op' })
    const viewed = vi.fn()
    const local = { attention: { viewed } }
    await expect(dispatchRemoteRequest(controller, peer, { protocol: 3, op: 'attentionViewed', sessionKey: 'claude\u0000\u0000/w\u0000s1' }, undefined, local))
      .resolves.toEqual({ viewed: true })
    expect(viewed).toHaveBeenCalledWith('claude\u0000\u0000/w\u0000s1')
    for (const bad of [{}, { sessionKey: '' }, { sessionKey: 7 }, { sessionKey: 'x'.repeat(4097) }, { sessionKey: 'k', extra: 1 }]) {
      await expect(dispatchRemoteRequest(controller, peer, { protocol: 3, op: 'attentionViewed', ...bad }, undefined, local))
        .resolves.toEqual({ error: 'invalid_request' })
    }
    expect(viewed).toHaveBeenCalledTimes(1)
  })
})
