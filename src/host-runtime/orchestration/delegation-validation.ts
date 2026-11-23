import type { AgentPermissionMode } from '../../shared/runtime-types'
import { INLINE_BODY_MAX_BYTES } from './types'

export const MAX_TITLE_CHARS = 120
export const MAX_REASON_CHARS = 2000
export const MAX_CLIENT_REQUEST_ID_CHARS = 256

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

export function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed)
  return Object.keys(obj).every((k) => set.has(k))
}

export interface ParsedDelegateArgs {
  task: string
  clientRequestId: string
  title: string | null
  role: string | null
  targetModel: string | null
  targetEffort: string | null
  permissionMode?: AgentPermissionMode
  mode?: 'async' | 'wait'
  timeoutMs?: unknown
}

export function parseDelegateArgs(
  args: Record<string, unknown>
): { ok: true; value: ParsedDelegateArgs } | { ok: false; code: string; message: string } {
  const allowed = ['task', 'title', 'role', 'target', 'permissionMode', 'isolation', 'mode', 'timeoutMs', 'clientRequestId']
  if (!hasOnlyKeys(args, allowed)) return { ok: false, code: 'invalid_request', message: 'Unexpected property in scry_task_delegate' }
  if (typeof args.task !== 'string' || args.task.trim().length === 0 || Buffer.byteLength(args.task, 'utf8') > INLINE_BODY_MAX_BYTES) {
    return { ok: false, code: 'invalid_request', message: 'task must be a non-empty string <= 16 KiB' }
  }
  if (typeof args.clientRequestId !== 'string' || args.clientRequestId.length === 0 || args.clientRequestId.length > MAX_CLIENT_REQUEST_ID_CHARS) {
    return { ok: false, code: 'invalid_request', message: 'clientRequestId is required and must be <= 256 chars' }
  }
  if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > MAX_TITLE_CHARS)) {
    return { ok: false, code: 'invalid_request', message: 'title must be <= 120 chars' }
  }
  if (args.role !== undefined && (typeof args.role !== 'string' || args.role.length > MAX_TITLE_CHARS)) {
    return { ok: false, code: 'invalid_request', message: 'role must be <= 120 chars' }
  }
  if (args.isolation !== undefined && args.isolation !== 'shared') {
    return { ok: false, code: 'capability_denied', message: 'Only isolation="shared" is supported in the first slice' }
  }
  let targetModel: string | null = null
  let targetEffort: string | null = null
  if (args.target !== undefined) {
    if (!isPlainRecord(args.target) || !hasOnlyKeys(args.target, ['model', 'effort'])) {
      return { ok: false, code: 'invalid_request', message: 'target only accepts model and effort in the first slice' }
    }
    if (args.target.model !== undefined && typeof args.target.model !== 'string') {
      return { ok: false, code: 'invalid_request', message: 'Invalid target.model' }
    }
    if (args.target.effort !== undefined && typeof args.target.effort !== 'string') {
      return { ok: false, code: 'invalid_request', message: 'Invalid target.effort' }
    }
    targetModel = (args.target.model as string | undefined) ?? null
    targetEffort = (args.target.effort as string | undefined) ?? null
  }
  return {
    ok: true,
    value: {
      task: args.task,
      clientRequestId: args.clientRequestId,
      title: (args.title as string | undefined) ?? null,
      role: (args.role as string | undefined) ?? null,
      targetModel,
      targetEffort,
      permissionMode: args.permissionMode as AgentPermissionMode | undefined,
      mode: args.mode as 'async' | 'wait' | undefined,
      timeoutMs: args.timeoutMs
    }
  }
}
