import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { workflowTemplateEditCopy as copy } from '@shared/constants/workflow-template-edit-copy'
import type { WorkflowTemplateSnapshot } from '@shared/workflow-template'
import { WorkflowTemplateEditCandidatePanel } from './WorkflowTemplateEditCandidatePanel'

const ref = { scope: { kind: 'builtin' as const }, domainId: 'a'.repeat(64), templateId: '341c060d-180c-40ab-945f-a093dca23271', revisionHash: 'b'.repeat(64) }
const source = JSON.stringify({ schemaVersion: 1, templateId: ref.templateId, name: 'Fixture', description: 'Before', parameters: {}, roles: [],
  body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'return', blockId: 'done', value: { kind: 'literal', value: 'ok' } }] } })
const snapshot = { ref, source, state: 'valid', definition: JSON.parse(source) } as WorkflowTemplateSnapshot
const task = { reference: { conversationId: '00000000-0000-4000-8000-000000000001', commandId: 'captured-edit' }, revision: 0, selection: { kind: 'saved' as const, ref } }
const agent = { id: 'codex', name: 'Codex', bin: 'codex', path: '/fixture/codex' }

describe('template edit candidate panel', () => {
  it('discloses sent and excluded data, unavailable cost estimate and the no-mutation boundary before the explicit call', () => {
    const html = renderToStaticMarkup(<WorkflowTemplateEditCandidatePanel task={task} snapshot={snapshot} current={snapshot}
      agents={[agent]} cwd="/workspace" orchestrator={{ role: 'orchestrator', providerId: 'codex' }} disabled={false} onDraft={() => undefined} />)
    for (const text of [copy.authoringTitle, copy.authoringSends, copy.authoringExcludes, copy.authoringCost, copy.authoringBoundary,
      copy.authoringConfirm, copy.authoringAction]) expect(html).toContain(text)
    expect(html).toContain('disabled=""')
  })

  it('reopens a durable candidate as read-only evidence with model, archive, validation and full source comparison', () => {
    const candidateSource = source.replace('Before', 'After')
    const authoring = { attemptId: 'attempt-1', taskRevision: 0, sourceRef: ref, author: { providerId: 'codex' as const }, requestedAt: 1,
      disclosure: { sourceBytes: Buffer.byteLength(source), sends: ['instruction', 'template_source', 'authoring_contract'] as const,
        excludes: ['conversation_history', 'attachments', 'workspace_files', 'credentials'] as const,
        estimatedCost: { state: 'unavailable' as const, reason: 'unavailable' } },
      state: { kind: 'candidate' as const, runId: 'run-1', archiveRef: 'archive-1', outputSource: 'fixture', actualModel: 'actual-model',
        candidateHash: 'c'.repeat(64), summary: 'Changed description', source: candidateSource, validation: { state: 'valid' as const } } }
    const { source: _source, ...summaryState } = authoring.state
    const html = renderToStaticMarkup(<WorkflowTemplateEditCandidatePanel task={{ ...task, authoring: { state: 'available', attempt: authoring,
      history: [{ ...authoring, state: summaryState }], applications: [] } }} snapshot={snapshot} current={snapshot}
      agents={[agent]} cwd="/workspace" orchestrator={{ role: 'orchestrator', providerId: 'codex' }} disabled={false} onDraft={() => undefined} />)
    for (const text of [copy.authoringCandidate, 'actual-model', 'archive-1', 'Changed description', candidateSource, source,
      copy.applyBoundary, copy.applyDestination, copy.applyConfirm, copy.applyAction, copy.authoringRetry, copy.authoringHistory]) expect(html).toContain(text.replaceAll('"', '&quot;'))
    expect(html).not.toContain(copy.authoringAction)
  })
})
