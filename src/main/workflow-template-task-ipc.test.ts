import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { fixture } from './workflow-ipc.fixture'

const request = {
  reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-template-command' },
  orchestrator: { role: 'orchestrator', providerId: 'codex', permissionMode: 'default' }, roles: []
}
describe('captured fixed-template trusted IPC', () => {
  it('rejects sender, child frame and changed origin before the preparation listener', async () => {
    const f = fixture()
    const invoke = async (event: IpcMainInvokeEvent) => f.handlers.get('workflow:prepareTemplateTask')!(event, request)
    await expect(invoke({ ...f.event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    await expect(invoke({ ...f.event, senderFrame: { url: f.frame.url } } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    f.frame.url = 'https://evil.invalid/'
    await expect(invoke(f.event)).rejects.toThrow('非可信 renderer')
    for (const listener of [...Object.values(f.service), ...Object.values(f.capturedTasks)]) expect(listener).not.toHaveBeenCalled()
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
  })

  it('refuses renderer source, paths, model-purpose and private preparation authority', async () => {
    const f = fixture()
    const invoke = async (payload: unknown) => f.handlers.get('workflow:prepareTemplateTask')!(f.event, payload)
    for (const extra of [{ cwd: '/forged' }, { command: '/scry-workflow run injected' },
      { source: { kind: 'saved', ref: {} } }, { frozenSource: true }, { beforePrepare: true },
      { observeOnly: true }, { purpose: 'workflow_authoring' }]) {
      await expect(invoke({ ...request, ...extra })).rejects.toThrow()
    }
    for (const value of [null, [], { ...request, reference: { ...request.reference, cwd: '/forged' } },
      { ...request, reference: { ...request.reference, commandId: '../outside' } },
      { ...request, orchestrator: { ...request.orchestrator, role: 'worker' } },
      { ...request, roles: [{ role: 'worker', providerId: 'unknown' }] },
      { ...request, roles: Array(4).fill({ role: 'worker', providerId: 'codex' }) }]) {
      await expect(invoke(value)).rejects.toThrow()
    }
    expect(f.capturedTasks.prepareTemplate).not.toHaveBeenCalled()
    expect(f.service.planCommand).not.toHaveBeenCalled()
    expect(f.service.start).not.toHaveBeenCalled()
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
    await invoke(request)
    expect(f.capturedTasks.prepareTemplate).toHaveBeenCalledExactlyOnceWith(request.reference, request.orchestrator, [])
    expect(f.service.planCommand).not.toHaveBeenCalled()
    expect(f.service.start).not.toHaveBeenCalled()
    expect(f.resolveWorkspace).not.toHaveBeenCalled()
  })
})
