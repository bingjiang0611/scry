import { describe, expect, it, vi } from 'vitest'
import { DAEMON_LOCAL_OP_CHANNELS } from '../daemon-channel-gate'
import { handleLocalOp, localOpCaller, localOpHandlersFor, type LocalOpHandler } from './host-local-ops'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import type { HostController } from './host-controller'
import { AppEventFeed } from './app-event-feed'

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
    await expect(dispatchRemoteRequest(controller, 'a'.repeat(64), { protocol: 2, op: 'sessionStore', method: 'listSessions', args: [] }))
      .resolves.toEqual({ error: 'unsupported_op' })
    const handlers = localOpHandlersFor(everyChannel(() => 'ok'))
    await expect(dispatchRemoteRequest(controller, 'a'.repeat(64), { protocol: 2, op: 'sessionStore', method: 'listSessions', args: [] }, undefined, { localOps: handlers }))
      .resolves.toEqual({ result: 'ok' })
  })

  it('serves the App event feed on the local endpoint only, and validates the request', async () => {
    const controller = {} as HostController
    const peer = 'a'.repeat(64)
    await expect(dispatchRemoteRequest(controller, peer, { protocol: 2, op: 'appEvents', cursor: 0, waitMs: 0 }))
      .resolves.toEqual({ error: 'unsupported_op' })
    const events = new AppEventFeed({ epoch: 'e1' })
    const local = { events }
    events.append({ kind: 'data', event: { kind: 'catalog_recovered' } })
    await expect(dispatchRemoteRequest(controller, peer, { protocol: 2, op: 'appEvents', epoch: 'e1', cursor: 0, waitMs: 0 }, undefined, local))
      .resolves.toEqual({ events: { epoch: 'e1', cursor: 1, items: [{ kind: 'data', event: { kind: 'catalog_recovered' } }] } })
    for (const bad of [
      { cursor: -1, waitMs: 0 }, { cursor: 0, waitMs: 1.5 }, { cursor: 0, waitMs: 0, epoch: 7 },
      { cursor: 0, waitMs: 0, epoch: 'x'.repeat(65) }, { cursor: 0, waitMs: 0, extra: true }
    ]) {
      await expect(dispatchRemoteRequest(controller, peer, { protocol: 2, op: 'appEvents', ...bad }, undefined, local))
        .resolves.toEqual({ error: 'invalid_request' })
    }
  })
})
