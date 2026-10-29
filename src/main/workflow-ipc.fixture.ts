import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { vi } from 'vitest'
import { registerTrustedIpcHandler } from './ipc-trust'
import { registerWorkflowIpc } from './workflow-ipc'
import type { WorkflowService } from './workflow-service'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
export function fixture(actualService?: Parameters<typeof registerWorkflowIpc>[0]['service']) {
  const handlers = new Map<string, Handler>()
  const frame = { url: 'file:///app/index.html' }
  const sender = { mainFrame: frame }
  const win = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const service = {
    sizeGuideline: vi.fn(async () => ({ value: 'medium', source: 'default', fingerprint: '0'.repeat(64) })),
    setSizeGuideline: vi.fn(async () => ({ value: 'small', source: 'preference', fingerprint: '1'.repeat(64) })),
    preview: vi.fn(async () => ({ workspace: '/authorized' })),
    findPreview: vi.fn(async (): Promise<{ workflowId: string; workspace: string } | undefined> => ({ workflowId: 'workflow-test', workspace: '/authorized' })),
    resume: vi.fn(async () => ({ state: 'nothing_to_resume', progress: null })),
    retry: vi.fn(async () => null),
    restartStalled: vi.fn(async () => null),
    prepareRevision: vi.fn(async () => null),
    revisePrepared: vi.fn(async () => null),
    planCommand: vi.fn(async () => null),
    approve: vi.fn(async () => true),
    start: vi.fn(async () => null),
    stop: vi.fn(async () => true),
    stopNode: vi.fn(async () => true),
    snapshot: vi.fn(async (): Promise<{ workspace: string } | undefined> => undefined),
    inspectFrame: vi.fn(async () => ({ state: 'unavailable', source: 'canonical_frame', observedAt: 1, reason: 'frame_missing' as const })),
    inspectExecution: vi.fn<WorkflowService['inspectExecution']>(async () => ({ state: 'unavailable', source: 'canonical_ledger', observedAt: 1, reason: 'root_missing' })),
    inspectOutput: vi.fn<WorkflowService['inspectOutput']>(async () => ({ state: 'unavailable', source: 'canonical_output', observedAt: 1, reason: 'root_missing' })),
    list: vi.fn(async () => ({ records: [] })),
    cancelPlanning: vi.fn(() => true)
  }
  const capturedTasks = { prepareTemplate: vi.fn(async () => null), plan: vi.fn(async () => null), cancel: vi.fn(async () => true), list: vi.fn(async () => ({ items: [] })), inspect: vi.fn(async () => null) }
  const templateEditAuthoring = { request: vi.fn(async () => null) }
  const templateEditApplication = { apply: vi.fn(async () => null) }
  const sourceApplications = { catalog: vi.fn(async () => ({ workflowId: 'workflow-test', programRevision: 'a'.repeat(64), workflowRevision: 0, reviewedAt: 1, items: [], receipts: [] })), apply: vi.fn(async () => null) }
  const resolveWorkspace = vi.fn((cwd: string) => { if (cwd !== '/authorized') throw new Error('unauthorized'); return cwd })
  registerWorkflowIpc({
    register: (channel, listener) => registerTrustedIpcHandler({ handle: (id, handler) => { handlers.set(id, handler) } }, channel, () => win, frame.url,
      (_event, ...args: unknown[]) => listener(...args)),
    capturedTasks: capturedTasks as unknown as Parameters<typeof registerWorkflowIpc>[0]['capturedTasks'],
    templateEditAuthoring: templateEditAuthoring as unknown as Parameters<typeof registerWorkflowIpc>[0]['templateEditAuthoring'],
    templateEditApplication: templateEditApplication as unknown as Parameters<typeof registerWorkflowIpc>[0]['templateEditApplication'],
    sourceApplications: sourceApplications as unknown as Parameters<typeof registerWorkflowIpc>[0]['sourceApplications'],
    service: actualService ?? (service as unknown as Parameters<typeof registerWorkflowIpc>[0]['service']), resolveWorkspace,
    assertCurrentWorkspace: cwd => { if (cwd !== '/authorized') throw new Error('stale workspace') }
  })
  return { handlers, event, frame, sender, service, capturedTasks, templateEditAuthoring, templateEditApplication, sourceApplications, resolveWorkspace }
}
