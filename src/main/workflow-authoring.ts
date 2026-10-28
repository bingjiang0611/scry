import type { AgentStartRequest } from '../shared/runtime'
import { workflowAuthoringCopy } from '../shared/constants/workflow-authoring-copy'
import type { AppRunStartOptions } from './app-run-start'
import type { ProviderAdapter } from './providers/types'

// This constrains the transport to a JSON object. The existing compiler remains
// authoritative for the full recursive grammar, roles, paths and execution limits.
export const workflowAuthoringSchema = { type: 'object' } as const

export async function assertWorkflowAuthoringIdentity(expected: string, readIdentity: () => Promise<string>): Promise<void> {
  if (await readIdentity() !== expected) throw new Error(workflowAuthoringCopy.identityChanged)
}

// A declared SDK configuration contract is not a successful native/account probe.
// This private Main purpose is never part of AgentStartRequest or renderer IPC.
export function assertWorkflowAuthoringStart(
  request: AgentStartRequest,
  options: AppRunStartOptions,
  declaration: ProviderAdapter['workflowAuthoring']
): boolean {
  if (options.purpose === undefined) {
    if (options.authoringSchema !== undefined) throw new Error(workflowAuthoringCopy.invalidPurpose)
    return false
  }
  if (options.purpose !== 'workflow_authoring' || options.origin !== 'workflow') {
    throw new Error(workflowAuthoringCopy.invalidPurpose)
  }
  if (!declaration) throw new Error(workflowAuthoringCopy.unavailable)
  if (request.expectedExternalSessionId !== null || request.forkLastTurn || request.restartLastTurn ||
    request.attachments?.length || request.permissionMode && request.permissionMode !== 'default' ||
    options.permissionModeOverride && options.permissionModeOverride !== 'default' ||
    options.managedConversation || options.workflowReplica || options.providerPrompt !== undefined) {
    throw new Error(workflowAuthoringCopy.invalidRunContext)
  }
  return true
}
