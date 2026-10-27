import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './io.js'

/**
 * Durable high-water mark of record sequence numbers.
 *
 * The sequence is the uploader's dedupe key and the delivery cursor, so it must never be reissued.
 * `records/` alone cannot prove which numbers were issued: an operator who deletes record files
 * without `scry turns archive` lowers the live maximum, and reusing that number makes the drain
 * skip every later record (delivery only walks sequences above `processedThrough`). The watermark
 * is written inside the commit lock before the record file exists, so a crash may skip a number
 * but can never repeat one.
 */
export interface SequenceWatermark {
  schemaVersion: 1
  /** Highest sequence ever allocated, whether or not its record file still exists. */
  lastIssued: number
}

export function sequenceWatermarkPath(dataRoot: string): string {
  return join(dataRoot, 'sequence-watermark.json')
}

/** Strict read: a damaged watermark must fail closed instead of restarting numbering at 1. */
export async function readSequenceWatermark(dataRoot: string): Promise<SequenceWatermark | null> {
  let source: string
  try {
    source = await readFile(sequenceWatermarkPath(dataRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let raw: Partial<SequenceWatermark>
  try {
    raw = JSON.parse(source) as Partial<SequenceWatermark>
  } catch {
    throw new Error('invalid sequence watermark: not valid JSON; refusing to allocate a sequence number')
  }
  if (raw?.schemaVersion !== 1 || !Number.isSafeInteger(raw.lastIssued) || (raw.lastIssued as number) < 0) {
    throw new Error('invalid sequence watermark; refusing to allocate a sequence number')
  }
  return { schemaVersion: 1, lastIssued: raw.lastIssued as number }
}

/**
 * Highest sequence the workspace already issued according to delivery checkpoints alone.
 *
 * Only used once, when the watermark file does not exist yet because an older CLI wrote the
 * workspace. Steady-state allocation never derives the number from delivery state: checkpoints are
 * per fingerprint, can lag and can be quarantined. An unreadable checkpoint fails closed here
 * rather than silently lowering the floor it was meant to raise.
 */
async function issuedFloorFromDeliveryCheckpoints(dataRoot: string): Promise<number> {
  const directory = join(dataRoot, 'notifications', 'commit-hooks')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let floor = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let state: { ackedThrough?: unknown; processedThrough?: unknown }
    try {
      state = JSON.parse(await readFile(join(directory, name), 'utf8')) as typeof state
    } catch {
      throw new Error(`cannot initialize sequence watermark: delivery checkpoint ${name} is unreadable`)
    }
    for (const value of [state.ackedThrough, state.processedThrough]) {
      if (Number.isSafeInteger(value) && (value as number) > floor) floor = value as number
    }
  }
  return floor
}

/**
 * Next sequence, computed but not yet reserved. The caller validates the record first; a rejected
 * draft must not burn a number, because a hole in `records/` reads as corruption afterwards.
 */
export async function nextSequence(
  dataRoot: string,
  live: { liveMax: number; archivedThrough: number }
): Promise<number> {
  const watermark = await readSequenceWatermark(dataRoot)
  const base = watermark === null
    ? Math.max(live.liveMax, live.archivedThrough, await issuedFloorFromDeliveryCheckpoints(dataRoot))
    : Math.max(watermark.lastIssued, live.liveMax, live.archivedThrough)
  return base + 1
}

/**
 * Durably raise the watermark to `sequence` before the record file is written. A crash after this
 * point can skip a number but can never reissue a delivered one.
 */
export async function reserveSequence(dataRoot: string, sequence: number): Promise<void> {
  const watermark = await readSequenceWatermark(dataRoot)
  if (watermark !== null && sequence <= watermark.lastIssued) {
    throw new Error(`sequence ${sequence} is not above the issued watermark ${watermark.lastIssued}`)
  }
  // Only our own lock serializes allocators, so `nextSequence` cannot have gone stale here.
  await writeJsonAtomic(sequenceWatermarkPath(dataRoot), { schemaVersion: 1, lastIssued: sequence } satisfies SequenceWatermark)
}
