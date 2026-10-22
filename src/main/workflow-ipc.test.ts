import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerTrustedIpcHandler } from './ipc-trust'
import { registerWorkflowIpc } from './workflow-ipc'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { FileWorkflowStore } from './workflow-store'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
function fixture(actualService?: Parameters<typeof registerWorkflowIpc>[0]['service']) {
  const handlers = new Map<string, Handler>()
  const frame = { url: 'file:///app/index.html' }
  const sender = { mainFrame: frame }
  const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const service = {
    preview: vi.fn(async () => ({ workspace: '/authorized' })),
    findPreview: vi.fn(async (): Promise<{ workspace: string } | undefined> => ({ workspace: '/authorized' })),
    resume: vi.fn(async () => ({ state: 'nothing_to_resume', progress: null })),
    planCommand: vi.fn(async () => null),
    approve: vi.fn(async () => true),
    start: vi.fn(async () => null),
    stop: vi.fn(async () => true),
    snapshot: vi.fn(async (): Promise<{ workspace: string } | undefined> => undefined),
    list: vi.fn(async () => ({ records: [] })),
    cancelPlanning: vi.fn(() => true)
  }
  const resolveWorkspace = vi.fn((cwd: string) => { if (cwd !== '/authorized') throw new Error('unauthorized'); return cwd })
  registerWorkflowIpc({
    register: (channel, listener) => registerTrustedIpcHandler({ handle: (id, handler) => { handlers.set(id, handler) } }, channel, () => win, frame.url,
      (_event, ...args: unknown[]) => listener(...args)),
    service: actualService ?? (service as unknown as Parameters<typeof registerWorkflowIpc>[0]['service']), resolveWorkspace,
    assertCurrentWorkspace: cwd => { if (cwd !== '/authorized') throw new Error('stale workspace') }
  })
  return { handlers, event, frame, sender, service, resolveWorkspace }
}
const plan = { command: '/scry-workflow run inspect', commandId: 'command-test', cwd: '/authorized',
  orchestrator: { role: 'orchestrator', providerId: 'codex' },
  roles: [{ role: 'worker', providerId: 'pi', agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } }] }
const approval = { workflowId: 'workflow-test', programRevision: 'revision', approvedAt: 1 }
const commands: Array<[string, unknown[]]> = [
  ['plan', [plan]], ['approve', [approval]], ['start', ['workflow-test', approval]], ['stop', ['workflow-test', 'stop-command']],
  ['resume', ['workflow-test', { ...approval, commandId: 'resume-command' }]],
  ['snapshot', ['workflow-test']], ['list', ['/authorized']], ['cancelPlanning', ['command-test']]
]

describe('workflow production IPC registrations', () => {
  it('validates both stop identities before the production privileged listener', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (id: unknown, commandId: unknown) => handlers.get('workflow:stop')!(event, id, commandId)
    for (const [id, commandId] of [['workflow-test', undefined], ['workflow-test', '../command'], ['../workflow', 'stop-command'], ['workflow-test', 'x'.repeat(97)]]) {
      await expect(invoke(id, commandId)).rejects.toThrow('身份无效')
    }
    expect(service.stop).not.toHaveBeenCalled()
    await expect(invoke('workflow-test', 'stop-command')).resolves.toBe(true)
    expect(service.stop).toHaveBeenCalledWith('workflow-test', 'stop-command')
  })
  it.each(commands)('rejects non-owner sender, frame and origin before %s privileged listener', async (channel, args) => {
    const { handlers, event, frame, sender, service, resolveWorkspace } = fixture()
    const handler = handlers.get(`workflow:${channel}`)!
    const invoke = async (input: IpcMainInvokeEvent) => handler(input, ...args)
    await expect(invoke({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    await expect(invoke({ ...event, senderFrame: { url: frame.url } } as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    frame.url = 'https://evil.invalid/'
    await expect(invoke({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent)).rejects.toThrow('非可信 renderer')
    for (const listener of Object.values(service)) expect(listener).not.toHaveBeenCalled()
    expect(resolveWorkspace).not.toHaveBeenCalled()
  })
  it('validates resume approval, command identity and workspace before continuing', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (id: string, payload: unknown) => handlers.get('workflow:resume')!(event, id, payload)
    await expect(invoke('workflow-test', approval)).rejects.toThrow('身份无效')
    await expect(invoke('other', { ...approval, commandId: 'resume-command' })).rejects.toThrow()
    expect(service.findPreview).not.toHaveBeenCalled()
    service.findPreview.mockResolvedValueOnce({ workspace: '/unauthorized' })
    service.snapshot.mockResolvedValueOnce({ workspace: '/authorized' })
    await expect(invoke('workflow-test', { ...approval, commandId: 'resume-command' })).rejects.toThrow('unauthorized')
    expect(service.resume).not.toHaveBeenCalled()
    expect(service.snapshot).not.toHaveBeenCalled()
    service.findPreview.mockResolvedValueOnce({ workspace: '/authorized' })
    await invoke('workflow-test', { ...approval, commandId: 'resume-command' })
    expect(service.resume).toHaveBeenCalledWith('workflow-test', approval, 'resume-command')
  })
  it('returns a missing-history no-op through the trusted handler without authorizing or synthesizing a workspace', async () => {
    const { handlers, event, service, resolveWorkspace } = fixture()
    service.findPreview.mockResolvedValueOnce(undefined)
    await expect(handlers.get('workflow:resume')!(event, 'workflow-test', { ...approval, commandId: 'resume-command' })).resolves.toEqual({ state: 'nothing_to_resume', progress: null })
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(service.snapshot).not.toHaveBeenCalled()
    expect(service.resume).toHaveBeenCalledWith('workflow-test', approval, 'resume-command')
  })
  it('handles genuinely absent file history through the trusted handler and real Service without any Provider invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-missing-history-ipc-'))
    try {
      const store = new FileWorkflowStore(root)
      const runControls = vi.fn<WorkflowServiceOptions['runControls']>()
      const plan = vi.fn<WorkflowServiceOptions['plan']>()
      const execute = vi.fn<WorkflowServiceOptions['execute']>()
      const service = new WorkflowService({ store, runControls, plan, execute, providerRegistered: () => false })
      const { handlers, event, resolveWorkspace } = fixture(service)
      await expect(handlers.get('workflow:resume')!(event, 'workflow-test', { ...approval, commandId: 'resume-command' })).resolves.toEqual({ state: 'nothing_to_resume', progress: null })
      expect(await store.load('workflow-test')).toBeUndefined()
      expect(runControls).not.toHaveBeenCalled()
      expect(plan).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      expect(resolveWorkspace).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('admits a valid cross-provider plan with a Pi profile/model, using canonical workspace authority', async () => {
    const { handlers, event, service } = fixture()
    await handlers.get('workflow:plan')!(event, plan)
    expect(service.planCommand).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/authorized',
      roles: [expect.objectContaining({ providerId: 'pi', agentProfileId: 'pi:default', requestedModel: { providerId: 'openai', id: 'fixture' } })] }))
  })
  it('rejects invalid role/model payload and unauthorized workspace without invoking the service', async () => {
    const { handlers, event, service } = fixture()
    const invoke = async (payload: unknown) => handlers.get('workflow:plan')!(event, payload)
    await expect(invoke({ ...plan, roles: Array(100).fill(plan.roles[0]) })).rejects.toThrow()
    await expect(invoke({ ...plan, cwd: '/unauthorized' })).rejects.toThrow('unauthorized')
    await expect(invoke({ ...plan, orchestrator: { ...plan.orchestrator, shell: 'bad' } })).rejects.toThrow()
    expect(service.planCommand).not.toHaveBeenCalled()
  })
  it('binds approval to exact identity and rejects malformed timestamps and path-like IDs', async () => {
    const { handlers, event, service } = fixture()
    const start = async (id: unknown, payload: unknown) => handlers.get('workflow:start')!(event, id, payload)
    await expect(start('another', approval)).rejects.toThrow()
    await expect(start('workflow-test', { ...approval, approvedAt: NaN })).rejects.toThrow()
    await expect(start('../workflow-test', { ...approval, workflowId: '../workflow-test' })).rejects.toThrow()
    expect(service.start).not.toHaveBeenCalled()
    await start('workflow-test', { ...approval, commandId: 'start-command' })
    expect(service.start).toHaveBeenCalledWith('workflow-test', approval, 'start-command')
  })
})
