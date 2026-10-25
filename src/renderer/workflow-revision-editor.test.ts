import { describe, expect, it } from 'vitest'
import type { WorkflowPlanPreview } from '@shared/workflow'
import { WORKFLOW_REVISION_COPY as copy } from './constants/copy'
import { workflowRevisionDraft, workflowRevisionSource } from './workflow-revision-editor'

const binding = { role: 'orchestrator', providerId: 'codex', runtimeIdentity: 'main-runtime' } as const
const preview: WorkflowPlanPreview = { workflowId: 'workflow-test', programRevision: 'revision', workspace: '/workspace', userGoal: 'inspect',
  orchestrator: binding, roles: [], state: 'ready', unavailableReasons: [], observedAt: 1, plannedCalls: 0,
  program: { schemaVersion: 1, workflowId: 'workflow-test', programRevision: 'revision', workspace: '/workspace', userGoal: 'inspect', roles: [binding],
    body: { kind: 'sequence', blockId: 'root', blocks: [{ kind: 'replica', blockId: 'copy' },
      { kind: 'check', blockId: 'check', replica: { kind: 'ref', name: 'copy' }, check: { argv: ['node', 'check.cjs'], cwd: '.', timeoutMs: 1000, parser: 'exit_code' },
        authorization: { argv: ['node', 'check.cjs'], cwd: '.', timeoutMs: 1000, parser: 'exit_code', executable: '/main/node', executableHash: 'digest', interpreters: [], launch: { executable: '/main/node', args: ['check.cjs'] }, replicaRoot: '/main/replica', replicaIdentity: { device: 1, inode: 2 }, workingDirectory: '/main/replica', environmentHash: 'environment', repositoryCode: true } },
      { kind: 'return', blockId: 'report', ref: { nodeId: 'check', path: ['passed'] } }] } } }

describe('workflow revision editable source', () => {
  it('excludes main authority while preserving source, and does not mutate the frozen preview', () => {
    const before = structuredClone(preview), source = workflowRevisionSource(preview)
    expect(Object.keys(JSON.parse(source)).sort()).toEqual(['body', 'roles', 'userGoal'])
    expect(source).not.toContain('authorization')
    expect(source).not.toContain('runtimeIdentity')
    expect(source).not.toContain('/main')
    expect(source).toContain('check.cjs')
    expect(workflowRevisionDraft(preview.workflowId, 7, source)).toEqual({ workflowId: preview.workflowId, expectedRevision: 7,
      userGoal: preview.userGoal, roles: [{ role: 'orchestrator', providerId: 'codex' }], body: JSON.parse(source).body })
    expect(preview).toEqual(before)
  })
  it('rejects non-source fields instead of treating JSON as a frozen preview or executable script', () => {
    for (const source of ['process.exit()', 'null', '[]', JSON.stringify(preview), JSON.stringify({ userGoal: 'x', roles: [], body: {}, workspace: '/other' })]) {
      expect(() => workflowRevisionDraft('workflow-test', 7, source)).toThrow(copy.invalidSource)
    }
  })
})
