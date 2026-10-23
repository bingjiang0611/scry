import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowTemplateApi } from '../shared/workflow-template'
import { registerTrustedIpcHandler } from './ipc-trust'
import { registerWorkflowTemplateIpc, registerWorkflowTemplateInstantiationIpc } from './workflow-template-ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
const calls: Array<[string, unknown[]]> = [
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
    const service = { instantiateTemplate: vi.fn() }, resolveWorkspace = vi.fn(async () => '/canonical/fixture')
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
  it.each(calls)('rejects foreign sender, frame and origin before %s privileged store call', async (method, args) => {
    const handlers = new Map<string, Handler>(), frame = { url: 'file:///app/index.html' }, sender = { mainFrame: frame }
    const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const store = { read: vi.fn(async () => null), list: vi.fn(async () => ({ templateIds: [] })), saveDraft: vi.fn(), draft: vi.fn(), publish: vi.fn() }
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
