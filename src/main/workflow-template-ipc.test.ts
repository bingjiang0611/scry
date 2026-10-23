import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowTemplateApi } from '../shared/workflow-template'
import type { WorkflowPlanPreview } from '../shared/workflow'
import { registerTrustedIpcHandler } from './ipc-trust'
import { registerWorkflowTemplateIpc, registerWorkflowTemplateInstantiationIpc } from './workflow-template-ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
const ref = { scope: { kind: 'personal' }, domainId: 'a'.repeat(64), templateId: '00000000-0000-4000-8000-000000000001', revisionHash: 'b'.repeat(64) }
const calls: Array<[string, unknown[]]> = [
  ['drafts', [ref.scope]],
  ['catalog', [ref.scope]],
  ['history', [ref.scope, ref.templateId]],
  ['revision', [ref]],
  ['restoreDraft', [{ ref, base: null }]],
  ['delete', [{ ref, commandId: 'delete-template' }]],
  ['read', [{ kind: 'personal' }, '00000000-0000-4000-8000-000000000001']],
  ['list', [{ kind: 'personal' }]],
  ['saveDraft', [{ source: '{}', scope: { kind: 'personal' } }]],
  ['draft', ['00000000-0000-4000-8000-000000000001']],
  ['publish', [{ draftId: '00000000-0000-4000-8000-000000000001', draftRevision: 1, candidateHash: 'a'.repeat(64), commandId: 'publish-test' }]]
]
describe('workflow template production IPC registration', () => {
  it('protects instantiation with the production trusted wrapper before resolving workspace or entering Service', async () => {
    const handlers = new Map<string, Handler>(), frame = { url: 'file:///app/index.html' }, sender = { mainFrame: frame }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const service = { instantiateTemplate: vi.fn(), extractTemplate: vi.fn(), preview: vi.fn() }, resolveWorkspace = vi.fn(async () => '/canonical/fixture')
    registerWorkflowTemplateInstantiationIpc((channel, listener) => registerTrustedIpcHandler({ handle: (id, handler) => { handlers.set(id, handler) } }, channel,
      () => win, frame.url, (_event, ...args: unknown[]) => listener(...args)), service, resolveWorkspace)
    const invoke = async (input: IpcMainInvokeEvent, payload: unknown = { cwd: '/fixture' }) => handlers.get('workflow:instantiateTemplate')!(input, payload)
    await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    await expect(invoke({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    frame.url = 'https://evil.invalid/'
    await expect(invoke(event)).rejects.toThrow('非可信 renderer')
    expect(resolveWorkspace).not.toHaveBeenCalled(); expect(service.instantiateTemplate).not.toHaveBeenCalled()
    frame.url = 'file:///app/index.html'
    await expect(invoke(event, { cwd: 7 })).rejects.toThrow()
    await expect(invoke(event, { cwd: '/fixture', shell: 'not allowed' })).rejects.toThrow()
    expect(resolveWorkspace).not.toHaveBeenCalled()
    resolveWorkspace.mockRejectedValueOnce(new Error('unauthorized workspace'))
    await expect(invoke(event)).rejects.toThrow('unauthorized workspace')
    expect(service.instantiateTemplate).not.toHaveBeenCalled()
    await invoke(event)
    expect(service.instantiateTemplate).toHaveBeenCalledExactlyOnceWith({ cwd: '/canonical/fixture' })
  })
  it('binds extraction to frozen source identity and workspace authority before a private draft write', async () => {
    const handlers = new Map<string, Handler>(), frame = { url: 'file:///app/index.html' }, sender = { mainFrame: frame }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const preview: WorkflowPlanPreview = { workflowId: 'workflow-source', programRevision: 'a'.repeat(64), workspace: '/frozen-source', userGoal: 'Frozen source', orchestrator: { role: 'orchestrator', providerId: 'codex' }, roles: [], plannedCalls: 0, state: 'draft', unavailableReasons: [], observedAt: 1,
      program: { workflowId: 'workflow-source', programRevision: 'a'.repeat(64), workspace: '/frozen-source', userGoal: 'Frozen source', roles: [], schemaVersion: 1, body: { kind: 'sequence', blockId: 'root', blocks: [] } } }
    const service = { instantiateTemplate: vi.fn(), extractTemplate: vi.fn(), preview: vi.fn(async () => preview) }, resolve = vi.fn(async () => '/frozen-source')
    registerWorkflowTemplateInstantiationIpc((channel, listener) => registerTrustedIpcHandler({ handle: (id, handler) => { handlers.set(id, handler) } }, channel,
      () => win, frame.url, (_event, ...args: unknown[]) => listener(...args)), service, resolve)
    const request = { workflowId: preview.workflowId, programRevision: preview.programRevision, scope: { kind: 'personal' }, name: 'Source', description: '', parameters: {} }
    const invoke = async (input: IpcMainInvokeEvent, payload: unknown = request) => handlers.get('workflow:extractTemplate')!(input, payload)
    await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    await expect(invoke({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    frame.url = 'https://evil.invalid/'
    await expect(invoke(event)).rejects.toThrow('非可信 renderer')
    expect(service.preview).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(service.extractTemplate).not.toHaveBeenCalled()
    frame.url = 'file:///app/index.html'
    await expect(invoke(event, { ...request, cwd: '/renderer-path' })).rejects.toThrow()
    await expect(invoke(event, { ...request, programRevision: 'b'.repeat(64) })).rejects.toThrow('修订已变化')
    expect(resolve).not.toHaveBeenCalled()
    resolve.mockRejectedValueOnce(new Error('source authority revoked'))
    await expect(invoke(event)).rejects.toThrow('source authority revoked')
    expect(service.extractTemplate).not.toHaveBeenCalled()
    await invoke(event)
    expect(resolve).toHaveBeenCalledWith('/frozen-source')
    expect(service.extractTemplate).toHaveBeenCalledExactlyOnceWith(request)
  })
  it.each(calls)('rejects foreign sender, frame and origin before %s privileged store call', async (method, args) => {
    const handlers = new Map<string, Handler>(), frame = { url: 'file:///app/index.html' }, sender = { mainFrame: frame }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const store = { drafts: vi.fn(async () => ({ drafts: [] })), catalog: vi.fn(async () => ({ templates: [] })), history: vi.fn(), revision: vi.fn(), restoreDraft: vi.fn(), delete: vi.fn(), read: vi.fn(async () => null), list: vi.fn(async () => ({ templateIds: [] })), saveDraft: vi.fn(), draft: vi.fn(), publish: vi.fn() }
    registerWorkflowTemplateIpc((channel, listener) => registerTrustedIpcHandler({ handle: (id, handler) => { handlers.set(id, handler) } }, channel,
      () => win, frame.url, (_event, ...args: unknown[]) => listener(...args)), store as WorkflowTemplateApi)
    const invoke = async (input: IpcMainInvokeEvent) => handlers.get('workflow:templates:' + method)!(input, ...args)
    await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    await expect(invoke({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    frame.url = 'https://evil.invalid/'
    await expect(invoke(event)).rejects.toThrow('非可信 renderer')
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled()
    frame.url = 'file:///app/index.html'
    await invoke(event)
    expect(store[method as keyof typeof store]).toHaveBeenCalledTimes(1)
  })
})
