import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'

// Only deployment/transport settings are pinned. Executable and trust identity always come
// from the current activation gate, never from a queued hook or a persisted environment.
export const UPLOAD_ENV_KEYS = [
  'SCRY_TURN_UPLOAD_ENABLED', 'SCRY_UPLOAD_DEADLINE_SECONDS',
  'SCRY_UPLOAD_LOCK_WAIT_SECONDS', 'SCRY_MANAGED_UPLOAD_WAIT_SECONDS',
  'SCRY_INSTALLATION_ID', 'SCRY_INSTALLATION_ID_FILE',
  'TMCP_TRACE_URL', 'RATE_NATIVE_ASYNC_QUEUE_DIR'
] as const
export const HOOK_ENV_KEYS = [...UPLOAD_ENV_KEYS, 'SCRY_RECORDER_ENABLED'] as const
export type UploadEnvironment = Partial<Record<typeof UPLOAD_ENV_KEYS[number], string>>

export function captureUploadEnvironment(env: NodeJS.ProcessEnv): UploadEnvironment {
  return Object.fromEntries(UPLOAD_ENV_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]))
}

export function applyHookEnvironment(env: NodeJS.ProcessEnv, snapshot: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of HOOK_ENV_KEYS) {
    delete result[key]
    if (snapshot[key] !== undefined) result[key] = snapshot[key]
  }
  return result
}

function environmentPath(dataRoot: string, recordId: string): string {
  return join(dataRoot, 'record-environments', `${recordId}.json`)
}

function validateEnvironment(value: unknown): asserts value is UploadEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.entries(value).some(([key, item]) => !UPLOAD_ENV_KEYS.some(allowed => key === allowed) || typeof item !== 'string')) {
    throw new Error('invalid record upload environment')
  }
}

export async function persistUploadEnvironment(dataRoot: string, recordId: string, values: UploadEnvironment): Promise<void> {
  validateEnvironment(values)
  await writeJsonAtomic(environmentPath(dataRoot, recordId), { schemaVersion: 1, recordId, values })
}

export async function recordUploadEnvironment(dataRoot: string, recordId: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const saved = await readJson<{ schemaVersion: number; recordId: string; values: unknown }>(environmentPath(dataRoot, recordId))
  // Old records have no snapshot. Their environment cannot be reconstructed retrospectively.
  if (saved === null) return env
  if (saved.schemaVersion !== 1 || saved.recordId !== recordId) throw new Error('invalid record upload environment identity')
  validateEnvironment(saved.values)
  const result = { ...env }
  for (const key of UPLOAD_ENV_KEYS) {
    delete result[key]
    if (saved.values[key] !== undefined) result[key] = saved.values[key]
  }
  return result
}

// NUL-delimited key/value pairs, an empty key, then the unchanged Provider JSON. Environment
// values cannot contain NUL. This preserves absence, empty strings and arbitrary UTF-8/control
// characters without shell JSON escaping, header injection, or an extra encoder process.
export function encodeHookEnvironment(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): string {
  return HOOK_ENV_KEYS.flatMap(key => env[key] === undefined ? [] : [key, env[key]]).join('\0') +
    (HOOK_ENV_KEYS.some(key => env[key] !== undefined) ? '\0' : '') + '\0' + JSON.stringify(payload)
}

export function decodeHookEnvironment(body: string): { env: NodeJS.ProcessEnv; payload: string } {
  const env: NodeJS.ProcessEnv = {}
  let offset = 0
  while (true) {
    const end = body.indexOf('\0', offset)
    if (end < 0) throw new Error('missing hook environment envelope')
    const key = body.slice(offset, end)
    offset = end + 1
    if (key === '') return { env, payload: body.slice(offset) }
    if (!HOOK_ENV_KEYS.some(allowed => key === allowed) || Object.hasOwn(env, key)) throw new Error('invalid hook environment key')
    const valueEnd = body.indexOf('\0', offset)
    if (valueEnd < 0) throw new Error('incomplete hook environment')
    env[key] = body.slice(offset, valueEnd)
    offset = valueEnd + 1
  }
}
