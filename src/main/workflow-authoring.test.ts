import { describe, expect, it } from 'vitest'
import { normalizeAgentStartRequest, type AgentStartRequest } from '../shared/runtime'
import { workflowAuthoringCopy } from '../shared/constants/workflow-authoring-copy'
import type { AppRunStartOptions } from './app-run-start'
import { assertWorkflowAuthoringStart, workflowAuthoringSchema } from './workflow-authoring'

const request: AgentStartRequest = {
  providerId: 'claude', prompt: 'Produce a candidate only', cwd: '/synthetic/workspace',
  expectedExternalSessionId: null, permissionMode: 'default'
}
const options: AppRunStartOptions = { origin: 'workflow', purpose: 'workflow_authoring' }
const declaration = { source: 'claude_sdk_success_result' } as const

describe('private Main workflow authoring purpose', () => {
  it('requires an explicit adapter declaration, not independent-run or model support', () => {
    expect(() => assertWorkflowAuthoringStart(request, options, undefined)).toThrow(workflowAuthoringCopy.unavailable)
    expect(assertWorkflowAuthoringStart(request, options, declaration)).toBe(true)
    expect(workflowAuthoringSchema).toEqual({ type: 'object' })
  })

  it.each([
    { expectedExternalSessionId: undefined },
    { expectedExternalSessionId: 'existing-session' },
    { permissionMode: 'full_access' as const },
    { permissionMode: 'auto_accept_edits' as const },
    { attachments: [{ kind: 'image' as const, mimeType: 'image/png' as const, name: 'private.png', dataBase64: 'eA==', size: 1 }] },
    { restartLastTurn: { replaceRunId: 'prior-run' } },
    { forkLastTurn: { replaceRunId: 'prior-run', replaceProviderTurnId: 'turn', replaceForkTurnId: 'fork' } }
  ])('refuses non-fresh or privileged input before any launch: %j', changed => {
    expect(() => assertWorkflowAuthoringStart({ ...request, ...changed }, options, declaration)).toThrow(workflowAuthoringCopy.invalidRunContext)
  })

  it.each([
    { permissionModeOverride: 'full_access' as const },
    { providerPrompt: 'unfrozen override' },
    { managedConversation: {} as NonNullable<AppRunStartOptions['managedConversation']> },
    { workflowReplica: {} as NonNullable<AppRunStartOptions['workflowReplica']> }
  ])('refuses Main history/replica/override authority: %j', changed => {
    expect(() => assertWorkflowAuthoringStart(request, { ...options, ...changed }, declaration)).toThrow(workflowAuthoringCopy.invalidRunContext)
  })

  it('does not turn a renderer payload into private Main authority', () => {
    const normalized = normalizeAgentStartRequest({ ...request, purpose: 'workflow_authoring' } as AgentStartRequest)
    expect(normalized).not.toHaveProperty('purpose')
    expect(assertWorkflowAuthoringStart(normalized, {}, declaration)).toBe(false)
    expect(() => assertWorkflowAuthoringStart(request, { ...options, origin: 'remote' }, declaration)).toThrow(workflowAuthoringCopy.invalidPurpose)
  })

  it('does not restrict ordinary Agent runs or their existing permission semantics', () => {
    expect(assertWorkflowAuthoringStart({ ...request, permissionMode: 'full_access', expectedExternalSessionId: 'normal' }, {}, undefined)).toBe(false)
  })
})
