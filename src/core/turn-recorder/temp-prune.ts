import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import type { RecorderSessionState } from './runtime-state.js'

export const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000

export const RETAINED_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000

const MARKER = 'stale-temp-prune.json'
const SCAN_DIRS = ['records', 'runtime', 'notifications', 'upload', 'locks']
const MAX_DEPTH = 4

export interface StaleTempPruneResult {
  removed: number
  bytes: number
  scanned: boolean
  retained: number
}

async function pruneDir(
  dir: string,
  cutoff: number,
  depth: number,
  out: StaleTempPruneResult,
  recurse = true
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (recurse && depth < MAX_DEPTH) await pruneDir(path, cutoff, depth + 1, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue
    try {
      const info = await stat(path)
      if (info.mtimeMs > cutoff) continue
      await rm(path, { force: true })
      out.removed++
      out.bytes += info.size
    } catch {
    }
  }
}

async function realDir(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => null)
  return info?.isDirectory() === true ? path : undefined
}

async function liveCaptureStores(sessionRoot: string): Promise<Set<string>> {
  const session = await readJson<RecorderSessionState>(join(sessionRoot, 'session.json')).catch(() => undefined)
  return new Set((session?.chainStores ?? []).map((store) => store))
}

async function pruneRetainedCaptures(
  dataRoot: string,
  cutoff: number,
  out: StaleTempPruneResult
): Promise<void> {
  const runtime = await realDir(join(dataRoot, 'runtime'))
  if (!runtime) return
  for (const provider of await readdir(runtime, { withFileTypes: true }).catch(() => [])) {
    if (!provider.isDirectory()) continue
    const providerDir = join(runtime, provider.name)
    for (const session of await readdir(providerDir, { withFileTypes: true }).catch(() => [])) {
      if (!session.isDirectory()) continue
      const sessionRoot = join(providerDir, session.name)
      const captures = await realDir(join(sessionRoot, 'segment-captures'))
      if (!captures) continue
      const live = await liveCaptureStores(sessionRoot)
      for (const entry of await readdir(captures, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue
        const dir = join(captures, entry.name)
        if ([...live].some((store) => store === dir || store.startsWith(`${dir}/`))) continue
        const info = await stat(dir).catch(() => null)
        if (!info || info.mtimeMs > cutoff) continue
        const size = await directoryBytes(dir)
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        out.retained++
        out.bytes += size
      }
    }
  }
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(path)
    else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size
  }
  return total
}

export async function pruneStaleTemps(
  dataRoot: string,
  options: { now?: number; olderThanMs?: number; retainedOlderThanMs?: number } = {}
): Promise<StaleTempPruneResult> {
  const now = options.now ?? Date.now()
  const ageMs = options.olderThanMs ?? STALE_TEMP_AGE_MS
  const runtime = await realDir(join(dataRoot, 'runtime'))
  const markerPath = runtime ? join(runtime, MARKER) : join(dataRoot, MARKER)
  const marker = await readJson<{ at?: unknown }>(markerPath)
  if (typeof marker?.at === 'string' && now - Date.parse(marker.at) < ageMs) {
    return { removed: 0, bytes: 0, scanned: false, retained: 0 }
  }
  const result: StaleTempPruneResult = { removed: 0, bytes: 0, scanned: true, retained: 0 }
  const cutoff = now - ageMs
  await pruneDir(dataRoot, cutoff, 0, result, false)
  for (const dir of SCAN_DIRS) {
    const path = await realDir(join(dataRoot, dir))
    if (path === undefined) continue
    await pruneDir(path, cutoff, 0, result)
  }
  await pruneRetainedCaptures(dataRoot, now - (options.retainedOlderThanMs ?? RETAINED_CAPTURE_AGE_MS), result)
  await writeJsonAtomic(markerPath, { at: new Date(now).toISOString() })
  return result
}
