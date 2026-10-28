import { vi } from 'vitest'
import type { Conversation } from '../shared/conversation'
import { SCRY_WORKFLOW_COMMAND_ID } from '../shared/task-command'
import type { WorkflowSizeGuideline } from '../shared/workflow-size'
import { createTaskCommandCatalog } from './task-command'
import { resolveWorkflowSize } from './workflow-size-guideline'
import { parseDesktopConversationSubmission, submitDesktopConversation } from './desktop-conversation-submission'
import type { WorkflowRouteResult } from '../shared/workflow-route'

export function fixture() {
  const conversation: Conversation = { version: 1, id: '00000000-0000-4000-8000-000000000001', cwd: '/synthetic/project',
    revision: 0, bindings: [], turns: [] }
  const request = { conversationId: conversation.id, expectedRevision: 0, commandId: 'control-command-one',
    prompt: '/scry-workflow list', selectedCommandId: SCRY_WORKFLOW_COMMAND_ID }
  const message = { providerId: 'codex', expectedContinuationKey: 'native-one', selectedItems: [], confirmFresh: true }
  const catalog = createTaskCommandCatalog({ conversationId: conversation.id, cwd: conversation.cwd,
    target: { providerId: 'codex', continuationKey: 'native-one' } }, {
    providerId: 'codex', cwd: conversation.cwd, mode: 'read', state: 'ready', data: []
  })
  const entry = {
    captureWorkflow: vi.fn(async (_conversation: Conversation, _request: { prompt: string; commandId: string }) => ({ kind: 'captured' as const, workspace: conversation.cwd,
      submission: { reference: { conversationId: request.conversationId, commandId: request.commandId }, planningCommandId: 'main-planning-command',
        size: { state: 'available' as const, snapshot: resolveWorkflowSize().snapshot, readAt: 1 } } })),
    commands: vi.fn(async () => catalog),
    submit: vi.fn(async () => ({ runId: 'existing-app-run', disposition: 'created' as const }))
  }
  const setSizeGuideline = vi.fn(async (value: WorkflowSizeGuideline | null) =>
    resolveWorkflowSize(undefined, value === null ? undefined : JSON.stringify({ workflowSizeGuideline: value })).snapshot)
  const templateTasks = { captureTemplate: vi.fn(async () => ({ kind: 'captured' as const, workspace: conversation.cwd,
    submission: { reference: { conversationId: request.conversationId, commandId: request.commandId }, instanceCommandId: 'main-template-command',
      size: { state: 'available' as const, snapshot: resolveWorkflowSize().snapshot, readAt: 1 },
      template: { state: 'available' as const, name: 'Frozen template', roles: ['orchestrator' as const],
        ref: { scope: { kind: 'personal' as const }, domainId: 'a'.repeat(64),
          templateId: '00000000-0000-4000-8000-000000000002', revisionHash: 'b'.repeat(64) } } }
  })) }
  const editTasks = { captureEdit: vi.fn(async (_conversation: Conversation, captured: { conversationId: string; commandId: string }, instruction: string) => ({
    kind: 'captured' as const, workspace: conversation.cwd,
    submission: { reference: { conversationId: captured.conversationId, commandId: captured.commandId },
      editCommandId: 'main-edit-command', selection: { kind: 'unselected' as const } },
    edit: { instruction }
  })) }
  const setWorkflowMode = vi.fn(async (_id: string, _revision: number, mode: 'off' | 'manual' | 'auto') => ({ ...conversation, workflowMode: mode }))
  const routeWorkflow = vi.fn(async (_conversation: Conversation, _input: unknown) => ({ kind: 'direct' }) as WorkflowRouteResult)
  const editTemplate = vi.fn(async () => ({ kind: 'resolved' as const }))
  const deps = { entry, setSizeGuideline, templateTasks, editTasks, setWorkflowMode, routeWorkflow, editTemplate }
  const submit = (input: unknown = request, current = conversation) =>
    submitDesktopConversation(current, parseDesktopConversationSubmission(input), deps)
  return { conversation, request, message, entry, templateTasks, editTasks, setSizeGuideline, setWorkflowMode, routeWorkflow, editTemplate, submit, catalog }
}
