import { isToolContentRef, type ContentRef } from './tool-content'

export const MANIFEST_FANOUT = 32

export interface ManifestRef {
  root: ContentRef
  from: number
  count: number
  bytes: number
  fanout: number
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isManifestRef(value: unknown): value is ManifestRef {
  if (value === null || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return isToolContentRef(ref.root) && isCount(ref.from) && ref.from === 0 &&
    isCount(ref.count) && ref.count > 0 && isCount(ref.bytes) && ref.fanout === MANIFEST_FANOUT
}
