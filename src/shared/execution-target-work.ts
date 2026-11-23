import type { DesktopMobileTargetSubmit } from './desktop-remote'

export const MAX_EXECUTION_TARGET_WORK_CALLS = 64

export type ExecutionTargetWorkCall =
  | { callId: string; method: 'executionTargets'; input: Record<string, never> }
  | { callId: string; method: 'mobileRequest'; input: { target: { id: string; binding: string }; request: Record<string, unknown> } }
  | { callId: string; method: 'mobileSubmit'; input: DesktopMobileTargetSubmit }
  | { callId: string; method: 'mobileIntentStatus'; input: { target: { id: string; binding: string }; phonePeerFingerprint: string; phoneIntentId: string; knownLogId?: string } }
  | { callId: string; method: 'shellOpenPath'; input: { path: string } }
  | { callId: string; method: 'shellTrashItem'; input: { path: string } }

export interface ExecutionTargetWorkReply {
  calls: ExecutionTargetWorkCall[]
  cancelledCallIds?: string[]
}

export interface ExecutionTargetWorkRequest {
  waitMs: number
  ackCancelledCallIds?: string[]
}

export function isExecutionTargetCallIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_EXECUTION_TARGET_WORK_CALLS &&
    value.every((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))
}
