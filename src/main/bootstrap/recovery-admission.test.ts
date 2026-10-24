import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from '../ipc-trust'
import { registerConversationHandlers } from './conversation'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function fixture(getStartupManagedRecovery: () => Promise<void>) {
  const handlers = new Map<string, Handler>()
  const mainFrame = { url: 'file:///test/renderer/index.html' }
  const sender = { mainFrame }
  const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const unexpected = (): never => { throw new Error('unexpected dependency') }
  const dispatched = new Error('privileged dispatch reached')
  const conversationService = vi.fn((): never => { throw dispatched })
  registerConversationHandlers({
    handleTrusted: (channel, listener) => registerTrustedIpcHandler(
      { handle: (name, handler) => { handlers.set(name, handler) } },
      channel, () => window, mainFrame.url, listener
    ),
    resolveKnownProjectDirectory: unexpected,
    providerContextKey: unexpected,
    contextAdmission: { run: unexpected, runMany: unexpected },
    getStartupManagedRecovery,
    appSessionStore: unexpected,
    conversationStore: unexpected,
    getRuns: unexpected,
    providerRegistry: { continuationKey: unexpected },
    providerSessionKey: unexpected,
    assertLegacyConversationWriteAllowed: unexpected,
    rememberProject: unexpected,
    deletingSessions: new Set(), adoptingSessionKeys: new Set(),
    conversationService,
    invalidateSessionHistoryLoad: unexpected,
    getWindow: () => window,
    deleteOneSession: unexpected,
    resolveSessionRunIds: unexpected,
    deleteConversationHistory: unexpected,
    appUserDataDir: '/unused-by-this-test'
  })
  return {
    conversationService, dispatched,
    fork: () => handlers.get('conversation:fork')!(event, {})
  }
}

describe('startup recovery admission', () => {
  it.each([false, true])('reads recovery assigned after IPC registration (reject=%s)', async (rejectRecovery) => {
    let recovery = Promise.resolve()
    const runtime = fixture(() => recovery)
    let resolve: () => void = () => { throw new Error('not initialized') }
    let reject: (error: Error) => void = () => { throw new Error('not initialized') }
    recovery = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
    // Also observe the fixture promise when a broken handler never waits for it.
    const recoveryOutcome = recovery.then(() => 'ready', (error: unknown) => error)
    const failure = new Error('startup recovery failed')
    const pending = runtime.fork()
    const outcome = expect(pending).rejects.toBe(rejectRecovery ? failure : runtime.dispatched)
    await Promise.resolve()
    const callsBeforeRecovery = runtime.conversationService.mock.calls.length
    if (rejectRecovery) reject(failure)
    else resolve()
    expect(await recoveryOutcome).toBe(rejectRecovery ? failure : 'ready')
    await outcome
    expect(callsBeforeRecovery).toBe(0)
    expect(runtime.conversationService).toHaveBeenCalledTimes(rejectRecovery ? 0 : 1)
  })
})
