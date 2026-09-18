import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isToolContentRef, type RecorderContentPage, type RecorderContentPageRequest } from '../shared/tool-content'
import { readRecorderContentPage } from '../core/turn-recorder/content-store'
import { listRecords, recordContentItems } from '../core/turn-recorder/store'

export const RECORDER_CONTENT_PAGE_MAX_BYTES = 64 * 1024
const AUTHORIZATION_CACHE_LIMIT = 16
const authorizationCache = new Map<string, { stamp: string; refs: Set<string> }>()

function refKey(ref: { sha256: string; bytes: number; encoding: string }): string {
  return `${ref.sha256}\0${ref.bytes}\0${ref.encoding}`
}

async function authorizedRefs(dataRoot: string): Promise<Set<string>> {
  let files: string[]
  try {
    files = (await readdir(join(dataRoot, 'records'))).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    files = []
  }
  // Record files are immutable. The complete filename set is therefore a sufficient cache stamp;
  // append/archive changes it, while reading a page does not reparse every historical record.
  const stamp = files.join('\0')
  const cached = authorizationCache.get(dataRoot)
  if (cached?.stamp === stamp) return cached.refs
  const refs = new Set((await listRecords(dataRoot)).flatMap(recordContentItems).map((item) => refKey(item.ref)))
  authorizationCache.delete(dataRoot)
  authorizationCache.set(dataRoot, { stamp, refs })
  while (authorizationCache.size > AUTHORIZATION_CACHE_LIMIT) {
    authorizationCache.delete(authorizationCache.keys().next().value!)
  }
  return refs
}

export async function readAuthorizedRecorderContentPage(
  dataRoot: string,
  value: unknown
): Promise<RecorderContentPage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_recorder_content_request')
  const raw = value as Partial<RecorderContentPageRequest>
  if (!isToolContentRef(raw.ref)) throw new Error('invalid_recorder_content_ref')
  const offset = raw.offset ?? 0
  const limit = raw.limit ?? RECORDER_CONTENT_PAGE_MAX_BYTES
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_recorder_content_offset')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECORDER_CONTENT_PAGE_MAX_BYTES) {
    throw new Error('invalid_recorder_content_limit')
  }
  if (!(await authorizedRefs(dataRoot)).has(refKey(raw.ref))) throw new Error('recorder_content_not_authorized')
  return readRecorderContentPage(dataRoot, raw.ref, { offset, limit })
}
