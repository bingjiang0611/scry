import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { ProviderDescriptor } from '../shared/provider'
import { ConversationStore } from './conversation-store'
import { createDesktopTaskEntry } from './desktop-task-entry'
import { createDesktopWorkflowTaskEntry } from './desktop-workflow-task-entry'
import { FileWorkflowStore } from './workflow-store'
import { WorkflowTemplateStore } from './workflow-template-store'
import { WorkflowService, type WorkflowServiceOptions } from './workflow-service'
import { WorkflowScopeError, WorkflowSlots } from './workflow-runner'
import { assertWorkflowAuthoringIdentity } from './workflow-authoring'

const descriptor: ProviderDescriptor = { id: 'codex', label: 'synthetic', runtimeProvider: 'codex_cli', transport: 'fixture', available: true,
  capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' }, health: { state: 'ready', transport: 'fixture' } }
export const orchestrator = { role: 'orchestrator' as const, providerId: 'codex' as const }
const output = JSON.stringify({ body: { kind: 'sequence', blockId: 'root', blocks: [
  { kind: 'call', blockId: 'scan', role: 'worker', prompt: 'inspect' }, { kind: 'return', blockId: 'done', ref: { nodeId: 'scan' } }
] } })
export async function workflowTaskFixture(roots: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'scry captured planning '))
  roots.push(directory)
  const userData = join(directory, 'userData'), workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const conversations = new ConversationStore(userData), workflows = new FileWorkflowStore(userData)
  const conversation = await conversations.create(workspace)
  const native = vi.fn(async () => { throw new Error('unexpected native context') })
  const intake = createDesktopTaskEntry({ store: () => conversations, service: vi.fn(() => { throw new Error('unexpected chat') }),
    getUserData: () => userData, resolveContinuationKey: native, discoverCommands: native })
  const request = { conversationId: conversation.id, commandId: 'captured-workflow-command', expectedRevision: conversation.revision,
    prompt: '  /scry-workflow run  exact raw goal  ' }
  const captured = await intake.captureWorkflow(conversation, request)
  if (captured.kind !== 'captured') throw new Error('fixture capture rejected')
  let providerEntries = 0
  const identity = { current: 'synthetic-planner-auth-scope-1' }
  const resolveIdentity = vi.fn(async () => identity.current)
  let beforeGuard: (() => Promise<void>) | undefined
  const plan = vi.fn<WorkflowServiceOptions['plan']>(async request => {
    await beforeGuard?.()
    try {
      if (request.expectedContinuationKey) await assertWorkflowAuthoringIdentity(request.expectedContinuationKey, async () => identity.current)
      await request.beforeProviderDispatch?.()
    } catch (error) { throw new WorkflowScopeError(String(error), true, 'not_attempted') }
    providerEntries++
    return { output, outputSource: 'scry_fixture_success_result', archiveRef: 'synthetic-archive' }
  })
  const execute = vi.fn<WorkflowServiceOptions['execute']>()
  const templates = new WorkflowTemplateStore(userData, cwd => {
    if (cwd !== conversation.cwd) throw new Error('unauthorized fixture workspace')
    return cwd
  }, join(directory, 'template-locks'))
  const makeService = (store = workflows) => new WorkflowService({ store, templates, slots: new WorkflowSlots(2), plan, execute, providerRegistered: () => true,
    runControls: async () => ({ descriptor, model: true, stop: true, identity: 'synthetic', independentRun: true, terminalOutput: true }) })
  const service = makeService()
  await service.snapshot('workflow-not-created')
  const controller = (ownerEpoch: string = intake.ownerEpoch, store = conversations, workflowStore = workflows, actualService = service) => createDesktopWorkflowTaskEntry({
    conversations: () => store, workflows: workflowStore, service: actualService, ownerEpoch, templates: () => templates, intake,
    resolveWorkspace: async cwd => { if (cwd !== conversation.cwd) throw new Error('unauthorized'); return cwd },
    resolveContinuationKey: resolveIdentity
  })
  const input = { command: request.prompt, commandId: captured.submission.planningCommandId, workspace: conversation.cwd,
    orchestrator, roles: [{ role: 'worker' as const, providerId: 'codex' as const }] }
  return { userData, conversations, workflows, templates, conversation, intake, request, captured, input, service, controller, makeService, native, plan, execute,
    identity, resolveIdentity, entries: () => providerEntries, hold: (callback: () => Promise<void>) => { beforeGuard = callback } }
}
