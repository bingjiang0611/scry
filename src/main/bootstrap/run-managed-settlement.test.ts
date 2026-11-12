import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ActiveRun } from '../../shared/trace'
import type { ManagedConversationStart } from '../conversation-service'
import { conversationItemsFromTrace } from '../conversation-history'
import { createManagedConversationSettlement } from './run-settlement'

vi.mock('../conversation-history', () => ({ conversationItemsFromTrace: vi.fn() }))

function harness(archived = true) {
  let commit!: () => void
  const committed = new Promise<void>(resolve => { commit = resolve })
  const onTerminal = vi.fn(async () => { await committed })
  const send = vi.fn()
  const getWindow = vi.fn(() => ({ webContents: { send } }) as unknown as BrowserWindow)
  const state: Parameters<typeof createManagedConversationSettlement>[0]['state'] = {
    terminalArchiveCommitted: archived, managedSettlementAttempted: false,
    terminalArchiveArgs: {
      agentProfileId: null, providerId: 'claude', runtimeProvider: 'claude_sdk', cwd: '/fixture',
      sessionId: 'native-1', runId: 'reply-1', userText: 'literal <img src=x>', items: [],
      done: true, status: 'completed', managedRecorderEnabled: false
    }
  }
  const deps = {
    state,
    managedConversation: { conversationId: 'child-1', onTerminal } as unknown as ManagedConversationStart,
    handle: { current: null }, cwd: '/fixture', runId: 'reply-1', displayPrompt: 'literal <img src=x>',
    runState: { runId: 'reply-1', items: [] } as unknown as ActiveRun,
    userDataDir: '/fixture-data', getWindow
  }
  return { deps, onTerminal, send, commit, settle: createManagedConversationSettlement(deps) }
}

beforeEach(() => { vi.mocked(conversationItemsFromTrace).mockReset().mockResolvedValue([]) })

describe('managed conversation settlement notification', () => {
  it('publishes the conversation identity only after its archive and durable delivery have settled', async () => {
    const run = harness()
    const pending = run.settle('completed')
    await vi.waitFor(() => expect(run.onTerminal).toHaveBeenCalledOnce())
    expect(run.onTerminal).toHaveBeenCalledWith(expect.objectContaining({ archive: { sessionId: 'native-1' } }))
    expect(run.send).not.toHaveBeenCalled()
    run.commit()
    await pending
    // No scoped run subscription is needed: a view that missed this fast run can refresh.
    expect(run.send).toHaveBeenCalledExactlyOnceWith('agent:dataUpdated', {
      kind: 'conversation_changed', conversationId: 'child-1'
    })
    await run.settle('completed')
    expect(run.send).toHaveBeenCalledOnce()
  })

  it('also refreshes an archive-less terminal, without claiming that history exists', async () => {
    const run = harness(false)
    const pending = run.settle('failed')
    expect(run.onTerminal).toHaveBeenCalledWith({ status: 'failed', finalItems: [], receipt: undefined })
    expect(run.send).not.toHaveBeenCalled()
    run.commit()
    await pending
    expect(run.send).toHaveBeenCalledOnce()
    expect(conversationItemsFromTrace).not.toHaveBeenCalled()
  })

  it('waits for the fallback durable outcome before notifying an extraction failure', async () => {
    const run = harness()
    vi.mocked(conversationItemsFromTrace).mockRejectedValueOnce(new Error('archive extraction failed'))
    const pending = run.settle('completed')
    await vi.waitFor(() => expect(run.onTerminal).toHaveBeenCalledOnce())
    expect(run.onTerminal).toHaveBeenCalledWith({ status: 'completed', finalItems: [], receipt: undefined })
    expect(run.send).not.toHaveBeenCalled()
    run.commit()
    await pending
    expect(run.send).toHaveBeenCalledOnce()
  })

  it('does not announce a durable change when both settlement attempts fail', async () => {
    const run = harness()
    run.onTerminal.mockRejectedValue(new Error('store failed'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await run.settle('failed')
      expect(run.onTerminal).toHaveBeenCalledTimes(2)
      expect(error).toHaveBeenCalledOnce()
      expect(run.send).not.toHaveBeenCalled()
    } finally { error.mockRestore() }
  })

  it('leaves an unmanaged run alone', async () => {
    const run = harness()
    const settle = createManagedConversationSettlement({ ...run.deps, managedConversation: undefined })
    await settle('completed')
    expect(run.onTerminal).not.toHaveBeenCalled()
    expect(run.send).not.toHaveBeenCalled()
  })
})
