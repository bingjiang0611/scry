import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { fixture } from './workflow-ipc.fixture'
import { MAX_RECORD_BYTES } from './workflow-store-artifacts'

const request = { workflowId: 'workflow-test', programRevision: 'a'.repeat(64), selection: { kind: 'attempt', attemptId: 'recorded-attempt' } }
describe('recorded output production trusted IPC', () => {
  it('rejects sender, frame and origin before the privileged output listener', async () => {
    const f = fixture(), listener = f.handlers.get('workflow:inspectOutput')!
    const events = [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url: f.frame.url } },
      { ...f.event, senderFrame: { url: 'https://untrusted.invalid/' } }
    ]
    for (const event of events) {
      await expect(Promise.resolve().then(() => listener(event as IpcMainInvokeEvent, request))).rejects.toThrow('非可信 renderer')
    }
    expect(f.service.inspectOutput).not.toHaveBeenCalled()
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
  })

  it('rejects forged artifacts, extra fields, invalid IDs, unpinned later pages and invalid bounds before service entry', async () => {
    const f = fixture(), listener = f.handlers.get('workflow:inspectOutput')!
    const invalid = [null, [], { ...request, path: '/private/file' }, { ...request, valueRef: {} },
      { ...request, workflowId: '../root' }, { ...request, programRevision: 'A'.repeat(64) },
      { ...request, selection: { ...request.selection, outputRef: '/private/file' } },
      { ...request, selection: { kind: 'attempt', attemptId: '../attempt' } },
      { ...request, selection: { kind: 'system', stepId: 'step', field: 'files' } },
      { ...request, selection: { kind: 'frame', frameId: '../frame' } },
      { ...request, selection: { kind: 'system', stepId: 'step', field: 'stdout', reference: {} } },
      { ...request, offset: -1 }, { ...request, offset: 1.5 }, { ...request, offset: MAX_RECORD_BYTES + 1 },
      { ...request, offset: 1 }, { ...request, offset: 1, expectedContentHash: 'invalid' },
      { ...request, expectedContentHash: 'B'.repeat(64) }]
    for (const payload of invalid) await expect(Promise.resolve().then(() => listener(f.event, payload))).rejects.toThrow()
    expect(f.service.inspectOutput).not.toHaveBeenCalled()
    expect(f.service.planCommand).not.toHaveBeenCalled()
    expect(f.service.start).not.toHaveBeenCalled()
  })

  it('forwards only logical selections and the Main-owned authority callback', async () => {
    const f = fixture(), listener = f.handlers.get('workflow:inspectOutput')!
    for (const selection of [request.selection, { kind: 'system', stepId: 'step', field: 'result' }, { kind: 'system', stepId: 'step', field: 'stdout' }, { kind: 'system', stepId: 'step', field: 'stderr' }, { kind: 'frame', frameId: 'recorded-frame' }]) {
      const query = { ...request, selection, offset: 8191, expectedContentHash: 'b'.repeat(64) }
      await listener(f.event, query)
      expect(f.service.inspectOutput).toHaveBeenLastCalledWith(query, f.resolveWorkspace)
    }
    expect(f.service.inspectOutput).toHaveBeenCalledTimes(5)
    expect(f.service.preview).not.toHaveBeenCalled()
  })
})
