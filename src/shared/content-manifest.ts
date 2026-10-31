import { isToolContentRef, type ContentRef } from './tool-content'

/**
 * Shared shape of a bounded-fanout content manifest.
 *
 * The tree arithmetic (counts, byte bounds, fanout) is written and checked in main; a
 * frozen side-chat record only needs the root reference and those totals, so the shape
 * lives here where the record and the renderer can both read it without a main import.
 */
/** Children or entries per node; a writer and a reader must agree on one value. */
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

/** Structural check only; node contents are validated against the tree in main. */
export function isManifestRef(value: unknown): value is ManifestRef {
  if (value === null || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  return isToolContentRef(ref.root) && isCount(ref.from) && ref.from === 0 &&
    isCount(ref.count) && ref.count > 0 && isCount(ref.bytes) && ref.fanout === MANIFEST_FANOUT
}
