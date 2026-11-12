import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'

/**
 * 原子写盘的临时文件正常存活只有毫秒级：写入 → `rename` 上屏。超过一天还在的 `.tmp` 只可能是
 * 进程被杀、机器断电之类的中断残留。它们不会被 rename 上屏，也不会被 `recordFiles` 认成记录，
 * 却会占空间，并让任何按目录枚举的脚本读到半成品（0 字节的 `…json.<pid>.<uuid>.tmp`）。
 */
export const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000

const MARKER = 'stale-temp-prune.json'
/** 这些目录放的是小 JSON 与正文之外的元数据；`content/` 与 `archive/` 不在其中。 */
const SCAN_DIRS = ['records', 'runtime', 'notifications', 'upload', 'locks']
const MAX_DEPTH = 4

export interface StaleTempPruneResult {
  /** 本次真正删除的文件数；每天只真正扫描一次，其余调用直接返回 0。 */
  removed: number
  bytes: number
  scanned: boolean
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
      // 别的进程可能同时清理或已经重命名；清理是附加卫生，不阻断写入方。
    }
  }
}

/**
 * 按天清理过期的 `.tmp`。提交是唯一已知的收敛点（App 托管路径与独立 CLI 都走 `commitRecord`），
 * 所以它负责这件事；标记文件让目录遍历最多每天发生一次，而不是加在每条记录的关键路径上。
 * 任何一步失败都只是这次不清理：它绝不阻断提交。
 */
export async function pruneStaleTemps(
  dataRoot: string,
  options: { now?: number; olderThanMs?: number } = {}
): Promise<StaleTempPruneResult> {
  const now = options.now ?? Date.now()
  const ageMs = options.olderThanMs ?? STALE_TEMP_AGE_MS
  const markerPath = join(dataRoot, 'runtime', MARKER)
  const marker = await readJson<{ at?: unknown }>(markerPath)
  if (typeof marker?.at === 'string' && now - Date.parse(marker.at) < ageMs) return { removed: 0, bytes: 0, scanned: false }
  const result: StaleTempPruneResult = { removed: 0, bytes: 0, scanned: true }
  const cutoff = now - ageMs
  // 数据根只扫它自己这一层的临时文件：往下一层就是 `content/`（几十万个 blob）和 `archive/`
  // （历史证据），既不产生这类临时文件，也不该为了清理临时文件去遍历。
  await pruneDir(dataRoot, cutoff, 0, result, false)
  for (const dir of SCAN_DIRS) await pruneDir(join(dataRoot, dir), cutoff, 0, result)
  await writeJsonAtomic(markerPath, { at: new Date(now).toISOString() })
  return result
}
