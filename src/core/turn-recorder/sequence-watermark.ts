import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './io.js'

export interface SequenceWatermark {
  schemaVersion: 1
  lastIssued: number
}

export function sequenceWatermarkPath(dataRoot: string): string {
  return join(dataRoot, 'sequence-watermark.json')
}

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

export async function reserveSequence(dataRoot: string, sequence: number): Promise<void> {
  const watermark = await readSequenceWatermark(dataRoot)
  if (watermark !== null && sequence <= watermark.lastIssued) {
    throw new Error(`sequence ${sequence} is not above the issued watermark ${watermark.lastIssued}`)
  }
  await writeJsonAtomic(sequenceWatermarkPath(dataRoot), { schemaVersion: 1, lastIssued: sequence } satisfies SequenceWatermark)
}
