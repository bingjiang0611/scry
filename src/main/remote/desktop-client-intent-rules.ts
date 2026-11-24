import { createHash, X509Certificate as NodeCertificate } from 'node:crypto'
import { isAgentPermissionMode } from '../../shared/runtime'
import type { DesktopRemoteContext, DesktopRemoteSubmit } from '../../shared/desktop-remote'
import type { WorkspaceStartSelection } from '../../shared/workspace-selection'
import { parseWorkspaceStartSelection } from '../../shared/workspace-selection-input'
import { DESKTOP_ATTACHMENT_MAX_COUNT } from './desktop-attachments'
import { context, digest, fail, record, text, type StoredConnection } from './desktop-client-validation'

export function isUnknownFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true
  return !/^(?:invalid_|desktop_protocol|desktop_capability|desktop_remote_|stop_not_confirmed|answer_not_confirmed|device_not_authorized|pairing_|device_certificate|unknown_|desktop_not_connected|desktop_client)/i.test(error.message)
}
export function isPreDispatchRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /^(?:desktop_remote_(?:device_not_authorized|invalid_request|invalid_intent_id|intent_payload_conflict|unknown_op|ledger_capacity_exceeded|attachments_unsupported|workspace_selection_unavailable)|attachment_transfer_failed|attachments_too_large|attachment_invalid|attachment_path_forbidden|desktop_not_connected|desktop_client_disposed|device_not_authorized|execution_target_binding_changed|unknown_connection)$/i.test(error.message)
}
export function isExplicitUnknownIntent(error: unknown): boolean { return error instanceof Error && /desktop_remote_unknown_intent$/i.test(error.message) }
export function assertSubmit(input: DesktopRemoteSubmit): void {
  if (!record(input) || typeof input.prompt !== 'string' || input.prompt.length > 128_000 || input.prompt.includes('\0')) fail('invalid_submit')
  if (input.prompt.length === 0 && (!Array.isArray(input.attachments) || input.attachments.length === 0)) fail('invalid_submit')
  context(input.context)
  for (const key of ['modelId', 'modelProviderId', 'effort'] as const) if (input[key] !== undefined && !text(input[key], 256)) fail('invalid_submit')
  if (input.permissionMode !== undefined && !isAgentPermissionMode(input.permissionMode)) fail('invalid_submit')
  if (input.workspace !== undefined) parseWorkspaceStartSelection(input.workspace)
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > DESKTOP_ATTACHMENT_MAX_COUNT)) fail('invalid_submit')
}
export function targetBinding(item: StoredConnection): string {
  if (!item.certificatePEM) return createHash('sha256').update(`${item.hostId}\0${item.anchorSHA256}\0missing`).digest('hex')
  let certificate: NodeCertificate
  try { certificate = new NodeCertificate(item.certificatePEM) } catch { fail('execution_target_binding_changed') }
  return createHash('sha256').update(`${item.hostId}\0${item.anchorSHA256}\0${digest(certificate.raw)}`).digest('hex')
}
export function workspaceFromDetail(detail: string): WorkspaceStartSelection | undefined {
  if (detail.length > 1_310_720) fail('invalid_submit')
  let value: unknown
  try { value = JSON.parse(detail) } catch { fail('invalid_submit') }
  if (!record(value) || value.workspace === undefined) return undefined
  try { return parseWorkspaceStartSelection(value.workspace) } catch { fail('invalid_submit') }
}
export function contextFromDetail(detail: string): DesktopRemoteContext {
  if (detail.length > 1_310_720) fail('invalid_submit')
  let value: unknown
  try { value = JSON.parse(detail) } catch { fail('invalid_submit') }
  if (!record(value) || !text(value.cwd, 16_384) || !text(value.providerId, 256)) fail('invalid_submit')
  return { cwd: value.cwd, providerId: value.providerId,
    ...(text(value.agentProfileId, 256) ? { agentProfileId: value.agentProfileId } : {}),
    ...(text(value.resume, 256) ? { externalSessionId: value.resume } : {}) }
}
