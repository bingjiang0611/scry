import { describe, expect, it, vi } from 'vitest'
import { DAEMON_LOCAL_OP_CHANNELS } from '../daemon-channel-gate'
import { handleLocalOp, localOpHandlersFor, type LocalOpHandler } from './host-local-ops'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import type { HostController } from './host-controller'

const everyChannel = (handler: LocalOpHandler) =>
  Object.fromEntries(Object.keys(DAEMON_LOCAL_OP_CHANNELS).map((channel) => [channel, handler]))

describe('local ops on the App endpoint', () => {
  it('calls the handler main would run with the renderer arguments', async () => {
    const listSessions = vi.fn(() => [{ id: 's1' }])
    const handlers = localOpHandlersFor({ ...everyChannel(() => undefined), 'agent:listSessions': listSessions })
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', args: [{ providerId: 'codex', cwd: '/w' }] }))
      .resolves.toEqual({ result: [{ id: 's1' }] })
    expect(listSessions).toHaveBeenCalledWith({ providerId: 'codex', cwd: '/w' })
    // JSON has no undefined: a handler that returns nothing answers null.
    await expect(handleLocalOp(handlers, { op: 'projectStore', method: 'recentFolders' })).resolves.toEqual({ result: null })
  })

  it('refuses malformed requests and methods it does not serve', async () => {
    const handlers = localOpHandlersFor(everyChannel(() => 'ok'))
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', cwd: '/etc' })).resolves.toEqual({ error: 'invalid_request' })
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'listSessions', args: [1, 2, 3, 4, 5] })).resolves.toEqual({ error: 'invalid_request' })
    await expect(handleLocalOp(handlers, { op: 'sessionStore', method: 'deleteEverything', args: [] })).resolves.toEqual({ error: 'unsupported_op' })
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
})
