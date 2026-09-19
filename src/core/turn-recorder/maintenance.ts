import { gzip as gzipCallback } from 'node:zlib'
import { promisify } from 'node:util'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { RecorderConfig } from './config.js'
import { listRecords, recordContentItems } from './store.js'
import { withDirectoryLock, writeFileAtomicExclusive } from './io.js'

const gzip = promisify(gzipCallback)
const CONTENT_FILE = /^[a-f0-9]{64}\.bin$/

export interface RecorderMaintenanceReport {
  applied: boolean
  blockedBy: string[]
  storeBytes: number
  maxBytes?: number
  overQuotaBytes: number
  retentionEligible: Array<{ sequence: number; completedAt: string }>
  orphanContent: Array<{ path: string; bytes: number }>
  staleTemps: Array<{ path: string; bytes: number }>
  compressedLogs: string[]
  reclaimedBytes: number
}

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (dir: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  await visit(root)
  return output
}

async function blockers(dataRoot: string, graceCutoff: number): Promise<string[]> {
  const blocked = new Set<string>()
  for (const path of await filesBelow(join(dataRoot, 'runtime'))) {
    if (path.endsWith('/open.json') || path.endsWith('/pending-open.json')) blocked.add('open_turn')
  }
  try { await stat(join(dataRoot, 'archive-journal.json')); blocked.add('archive_journal') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const path of await filesBelow(join(dataRoot, 'locks'))) {
    if (path.includes('/maintenance.lock/') || path.includes('/commit.lock/')) continue
    blocked.add('active_lock')
  }
  for (const path of await filesBelow(dataRoot)) {
    if (!path.endsWith('.tmp')) continue
    const info = await stat(path)
    if (info.mtimeMs > graceCutoff) blocked.add('recent_temp')
  }
  return [...blocked].sort()
}

export async function maintainRecorderStore(
  dataRoot: string,
  config: RecorderConfig,
  options: { apply?: boolean; now?: number } = {}
): Promise<RecorderMaintenanceReport> {
  const now = options.now ?? Date.now()
  const graceMs = (config.storage?.orphanGraceHours ?? 24) * 60 * 60 * 1_000
  const graceCutoff = now - graceMs
  return withDirectoryLock(join(dataRoot, 'locks', 'maintenance.lock'), () =>
    withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    const blockedBy = await blockers(dataRoot, graceCutoff)
    const records = await listRecords(dataRoot)
    const referenced = new Set(records.flatMap(recordContentItems).map((item) => item.ref.sha256))
    const orphanContent: RecorderMaintenanceReport['orphanContent'] = []
    const staleTemps: RecorderMaintenanceReport['staleTemps'] = []
    const allFiles = await filesBelow(dataRoot)
    let storeBytes = 0
    for (const path of allFiles) {
      const info = await stat(path)
      storeBytes += info.size
      const relativePath = relative(dataRoot, path)
      const name = path.split('/').at(-1) ?? ''
      if (relativePath.startsWith('content/sha256/') && CONTENT_FILE.test(name) && !referenced.has(name.slice(0, -4)) && info.mtimeMs <= graceCutoff) {
        orphanContent.push({ path: relativePath, bytes: info.size })
      }
      if (path.endsWith('.tmp') && info.mtimeMs <= graceCutoff) staleTemps.push({ path: relativePath, bytes: info.size })
    }
    const retentionCutoff = config.storage?.retentionDays == null
      ? undefined
      : now - config.storage.retentionDays * 24 * 60 * 60 * 1_000
    const retentionEligible = retentionCutoff == null ? [] : records
      .filter((record) => Date.parse(record.completedAt) <= retentionCutoff)
      .map((record) => ({ sequence: record.sequence, completedAt: record.completedAt }))
    const maxBytes = config.storage?.maxBytes
    const overQuotaBytes = maxBytes == null ? 0 : Math.max(0, storeBytes - maxBytes)
    const canApply = options.apply === true && blockedBy.length === 0
    let reclaimedBytes = 0
    if (canApply) {
      for (const item of [...orphanContent, ...staleTemps]) {
        await rm(join(dataRoot, item.path), { force: true })
        reclaimedBytes += item.bytes
      }
    }
    const compressedLogs: string[] = []
    if (canApply) {
      for (const path of allFiles.filter((candidate) => candidate.endsWith('.log.1'))) {
        const target = `${path}.gz`
        try {
          await stat(target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const source = await readFile(path)
          await writeFileAtomicExclusive(target, await gzip(source))
          await rm(path)
          compressedLogs.push(relative(dataRoot, target))
        }
      }
    }
    return {
      applied: canApply,
      blockedBy,
      storeBytes,
      ...(maxBytes != null ? { maxBytes } : {}),
      overQuotaBytes,
      retentionEligible,
      orphanContent,
      staleTemps,
      compressedLogs,
      reclaimedBytes
    }
  }))
}
