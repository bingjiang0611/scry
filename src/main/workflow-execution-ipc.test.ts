import { describe, expect, it } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { fixture } from './workflow-ipc.fixture'

const request = { workflowId: 'inspection-root', programRevision: 'a'.repeat(64), kind: 'attempts' }
describe('execution inspection trusted IPC', () => {
  it('passes only normalized bounded queries and the Main workspace authority', async () => {
    const f = fixture(), invoke = f.handlers.get('workflow:inspectExecution')!
    await invoke(f.event, { ...request, nodeId: 'call_0', offset: 32 })
    expect(f.service.inspectExecution).toHaveBeenCalledExactlyOnceWith({ ...request, nodeId: 'call_0', offset: 32 }, f.resolveWorkspace)
    expect(f.service.start).not.toHaveBeenCalled(); expect(f.service.planCommand).not.toHaveBeenCalled()
  })

  it('rejects malformed selectors before the ledger reader is called', async () => {
    const f = fixture(), invoke = f.handlers.get('workflow:inspectExecution')!
    for (const input of [null, [], { ...request, cwd: '/outside' }, { ...request, workflowId: '../outside' },
      { ...request, programRevision: 'wrong' }, { ...request, kind: 'all' }, { ...request, nodeId: '../node' },
      { ...request, offset: -32 }, { ...request, offset: 1 }, { ...request, offset: 16385 }, { ...request, offset: Infinity }]) {
      await expect(Promise.resolve().then(() => invoke(f.event, input))).rejects.toThrow()
    }
    expect(f.service.inspectExecution).not.toHaveBeenCalled()
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
  })

  it('triggers the production sender/frame/origin wrapper, never the privileged reader', async () => {
    const f = fixture(), invoke = f.handlers.get('workflow:inspectExecution')!
    const events = [
      { sender: {}, senderFrame: f.frame },
      { sender: f.sender, senderFrame: { url: f.frame.url } },
      { sender: f.sender, senderFrame: { url: 'https://untrusted.example/' } }
    ]
    for (const event of events) await expect(Promise.resolve().then(() => invoke(event as IpcMainInvokeEvent, request))).rejects.toThrow()
    expect(f.service.inspectExecution).not.toHaveBeenCalled()
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
  })
})
