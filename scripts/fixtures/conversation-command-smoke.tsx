import { useRef, useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationPage, ConversationPreview, ConversationSubmissionRequest, ConversationSubmissionResult, ConversationTargetRequest } from '../../src/shared/conversation-api'
import type { WorkflowApi, WorkflowTaskInspection, WorkflowTaskReference, WorkflowTaskSummary } from '../../src/shared/workflow-api'
import type { WorkflowPlanPreview } from '../../src/shared/workflow'
import type { DetectedAgent } from '../../src/renderer/env'
import { WORKFLOW_SIZE_COPY } from '../../src/renderer/constants/copy'
import { SCRY_WORKFLOW_COMMAND_ID, type TaskCommandCatalog } from '../../src/shared/task-command'
import { ConversationView } from '../../src/renderer/components/ConversationView'
import type { SessionChatView } from '../../src/renderer/components/ChatView'
import { composerDraftKey, createComposerDraftStore } from '../../src/renderer/composer-drafts'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

const conversation = { id: '00000000-0000-4000-8000-000000000001', cwd: '/synthetic/command-ui', title: 'Command fixture', revision: 0, turnCount: 0 }
const page: ConversationPage = { summary: conversation, bindings: [], turns: [] }
const draftKey = composerDraftKey({ providerId: 'conversation', cwd: conversation.cwd, sessionId: conversation.id })
const draftStore = createComposerDraftStore(new Map())
const known: TaskCommandCatalog = { scope: 'synthetic-known', provider: { state: 'unknown', complete: false }, commands: [
  { id: SCRY_WORKFLOW_COMMAND_ID, name: 'scry-workflow', description: 'Synthetic Scry command metadata', origin: { kind: 'scry_workflow' }, ambiguous: false }
] }
const calls = { metadata: [] as Array<ConversationTargetRequest | undefined>, submissions: [] as ConversationSubmissionRequest[], previews: 0, plans: 0, workflowPlans: [] as unknown[], catalogs: 0,
  taskLists: [] as Array<{ conversationId: string; cursor?: string }>, taskInspections: [] as WorkflowTaskReference[],
  controls: [] as unknown[], templatePreparations: [] as unknown[], cancellations: [] as unknown[], approvals: [] as unknown[], starts: [] as unknown[] }
const task = (digit: string, phase: WorkflowTaskSummary['phase']): WorkflowTaskSummary => ({
  reference: { conversationId: conversation.id, commandId: `captured-${digit}` }, submissionId: `submission-${digit.repeat(64)}`,
  phase, revision: 0, createdAt: 1, size: { state: 'available', snapshot: { value: 'medium', source: 'default', fingerprint: '0'.repeat(64) }, readAt: 1 }
})
const capturedTask = task('1', 'captured'), observedTask = task('2', 'unknown'), interruptedTask = task('3', 'captured')
let lastPreview: WorkflowPlanPreview
let observedProgress: 'completed' | 'awaiting_approval' = 'completed'
let holdTemplatePreparation = false
let releaseTemplatePreparation: (() => void) | undefined
let holdInspection = false
let releaseInspection: (() => void) | undefined
let failTaskList = false
let setConversation: (id: string) => void = () => {}
const outcomes: Array<ConversationSubmissionResult | Error> = []
let releaseMetadata: ((catalog: TaskCommandCatalog) => void) | undefined
let holdMetadata = false
let setScope: (value: string) => void = () => {}
const noAction = () => {}
const agents = [{ id: 'codex', name: 'Synthetic Codex' }] as DetectedAgent[]
Object.assign(window, { scry: {
  runControls: async (...args: unknown[]) => { calls.controls.push(args); return { state: 'ready', mode: 'read', data: {
    models: [{ model: { id: 'synthetic-model' }, label: 'Synthetic model', efforts: [] }],
    permissions: [{ id: 'default', label: 'Synthetic default', description: 'Synthetic fixture' }]
  }} },
  conversations: {
    read: async (id: string) => ({ ...page, summary: { ...page.summary, id } }),
    commands: async (_id: string, target?: ConversationTargetRequest) => {
      calls.metadata.push(target)
      if (target && holdMetadata) return new Promise<TaskCommandCatalog>(resolve => { releaseMetadata = resolve })
      return known
    },
    submit: async (request: ConversationSubmissionRequest) => {
      calls.submissions.push(structuredClone(request))
      const outcome = outcomes.shift()
      if (!outcome) throw new Error('No scripted UI response: unexpected submit')
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    preview: async (_id: string, target: ConversationTargetRequest): Promise<ConversationPreview> => {
      calls.previews++
      return { conversationId: conversation.id, revision: 0, target: { ...target, continuationKey: 'synthetic-native-key' },
        continuation: { kind: 'fresh', missingItems: [] }, missingItems: [] }
    }
  },
  onDataUpdated: () => noAction,
  workflow: {
    capturedTasks: async (conversationId: string, cursor?: string) => {
      calls.taskLists.push({ conversationId, cursor })
      if (failTaskList) { failTaskList = false; throw new Error('Synthetic task read failure') }
      return { items: cursor ? [interruptedTask] : [capturedTask, observedTask], nextCursor: cursor ? undefined : 'synthetic-next', observedAt: 1 }
    },
    inspectTask: async (reference: WorkflowTaskReference): Promise<WorkflowTaskInspection> => {
      calls.taskInspections.push(reference)
      if (holdInspection) await new Promise<void>(resolve => { releaseInspection = resolve })
      const row = reference.commandId === 'captured-1' ? capturedTask : reference.commandId === 'captured-2' ? observedTask : interruptedTask
      return { task: row, command: '/scry-workflow run original captured goal', workspace: conversation.cwd,
        submission: { reference: row.reference, planningCommandId: row.submissionId, size: row.size }, observedAt: 1,
        outcome: row === capturedTask ? { kind: 'configure' } : row === observedTask ?
          { kind: 'preview', preview: lastPreview, progressState: observedProgress } : { kind: 'blocked', reason: 'interrupted' } }
    },
    templates: { catalog: async () => { calls.catalogs++; return { templates: [] } } },
    plan: async (request: Parameters<WorkflowApi['plan']>[0]): Promise<WorkflowPlanPreview> => {
      calls.workflowPlans.push(structuredClone(request))
      lastPreview = { workflowId: 'synthetic-workflow', programRevision: 'synthetic-revision', userGoal: 'preserve this goal', workspace: request.cwd,
        orchestrator: request.orchestrator, roles: [], plannedCalls: 0, state: 'ready', unavailableReasons: [], observedAt: 1,
        program: { schemaVersion: 1, workflowId: 'synthetic-workflow', programRevision: 'synthetic-revision', userGoal: 'preserve this goal', workspace: request.cwd,
          roles: [request.orchestrator, ...request.roles], body: { kind: 'sequence', blockId: 'root', blocks: [] } } }
      return lastPreview
    },
    prepareTemplateTask: async (request: Parameters<WorkflowApi['prepareTemplateTask']>[0]): Promise<WorkflowPlanPreview> => {
      calls.templatePreparations.push(structuredClone(request))
      if (holdTemplatePreparation) await new Promise<void>(resolve => { releaseTemplatePreparation = resolve })
      return { ...lastPreview, workflowId: 'synthetic-template-workflow', programRevision: 'synthetic-template-revision',
        userGoal: 'Frozen template command', orchestrator: request.orchestrator,
        program: { ...lastPreview.program, roles: [request.orchestrator, ...request.roles] } }
    },
    approve: async (...args: unknown[]) => { calls.approvals.push(args); return true },
    start: async (...args: unknown[]) => { calls.starts.push(args); return undefined },
    cancelPlanning: async (...args: unknown[]) => { calls.cancellations.push(args); return true }
  }
} })
function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [agent, selectAgent] = useState('codex')
  const [conversationId, selectConversation] = useState(conversation.id)
  setConversation = selectConversation
  setScope = selectAgent
  const chatProps: ComponentProps<typeof SessionChatView> = {
    draftStore, draftKey, turns: [], selectedId: null, scrollRef, textareaRef, cwd: conversation.cwd, recent: [], agents,
    selectedAgentId: agent, runControls: { permissionMode: 'default' }, runControlCatalog: { models: [], permissions: [] },
    busy: false, draftAttachments: [], queuedPrompts: [], slashOpen: false, slashLoading: false, slashCmds: [], slashSel: 0,
    onSelect: noAction, onInput: noAction, onChooseFolder: noAction, onPickRecent: noAction, onRemoveRecent: noAction,
    onRetrySlash: noAction, onPickSlash: noAction, onSlashSel: noAction, onHideSlash: noAction, onSend: noAction, onStop: noAction,
    onPasteImages: noAction, onPasteClipboardImage: noAction, onRemoveDraftAttachment: noAction, onRemoveQueuedPrompt: noAction,
    onSelectAgent: selectAgent, onRunModel: noAction, onRunEffort: noAction, onPermissionMode: noAction
  }
  return <ConversationView conversation={{ ...conversation, id: conversationId }} draftStore={draftStore} chatProps={chatProps}
    onChanged={noAction} onProjection={noAction} onOpenConversation={noAction} onWorkflow={() => { calls.plans++ }} />
}
const root = createRoot(document.getElementById('root')!)
root.render(<Harness />)
Object.assign(window, { conversationCommandFixture: {
  known, calls, outcomes,
  holdTemplatePreparation: () => { holdTemplatePreparation = true },
  releaseTemplatePreparation: () => { holdTemplatePreparation = false; releaseTemplatePreparation?.() },
  expectedCapturedSize: WORKFLOW_SIZE_COPY.recorded(WORKFLOW_SIZE_COPY.values.medium, WORKFLOW_SIZE_COPY.sources.default),
  draft: () => draftStore.getSnapshot().get(draftKey)?.input ?? '',
  taskRows: { captured: capturedTask, observed: observedTask, interrupted: interruptedTask },
  failTaskList: () => { failTaskList = true },
  observeReady: () => { observedProgress = 'awaiting_approval' },
  holdTaskInspection: () => { holdInspection = true },
  releaseTaskInspection: () => { holdInspection = false; releaseInspection?.() },
  conversation: (id: string) => setConversation(id),
  scope: (value: string) => setScope(value),
  holdMetadata: () => { holdMetadata = true },
  releaseMetadata: () => { holdMetadata = false; releaseMetadata?.({ ...known, scope: 'stale-native', commands: [
    ...known.commands, { id: 'stale-provider', name: 'stale-native-command', description: 'Must be discarded', origin: { kind: 'provider', providerId: 'codex' }, ambiguous: false }
  ] }) },
  unmount: () => root.unmount()
} })
