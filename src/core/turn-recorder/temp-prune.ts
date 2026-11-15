import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import type { RecorderSessionState } from './runtime-state.js'

/**
 * 原子写盘的临时文件正常存活只有毫秒级：写入 → `rename` 上屏。超过一天还在的 `.tmp` 只可能是
 * 进程被杀、机器断电之类的中断残留。它们不会被 rename 上屏，也不会被 `recordFiles` 认成记录，
 * 却会占空间，并让任何按目录枚举的脚本读到半成品（0 字节的 `…json.<pid>.<uuid>.tmp`）。
 */
export const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1_000

/**
 * 接续段冻结的 object store 只在同一会话的下一次真实提问之前有用；没有会话状态引用它、
 * 且已经过去一天，就只能是关闭会话或进程被杀后的残留。引用优先于时间：会话状态里仍列出的
 * store（`chainStores`）不管多旧都不动，时间只决定无人引用的目录何时算无主。
 */
export const RETAINED_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000

const MARKER = 'stale-temp-prune.json'
/** 这些目录放的是小 JSON 与正文之外的元数据；`content/` 与 `archive/` 不在其中。 */
const SCAN_DIRS = ['records', 'runtime', 'notifications', 'upload', 'locks']
const MAX_DEPTH = 4

export interface StaleTempPruneResult {
  /** 本次真正删除的文件数；每天只真正扫描一次，其余调用直接返回 0。 */
  removed: number
  bytes: number
  scanned: boolean
  /** 本次清理的无人引用接续段 object store 目录数。 */
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
      // 别的进程可能同时清理或已经重命名；清理是附加卫生，不阻断写入方。
    }
  }
}

/** 入口必须是真实目录：沿符号链接清理会跑到工作区外，且那不是 recorder 写的字节。 */
async function realDir(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => null)
  return info?.isDirectory() === true ? path : undefined
}

/** 一个会话仍需要的 object store：状态里明确列出的 chainStores，路径是绝对路径。 */
async function liveCaptureStores(sessionRoot: string): Promise<Set<string>> {
  const session = await readJson<RecorderSessionState>(join(sessionRoot, 'session.json')).catch(() => undefined)
  return new Set((session?.chainStores ?? []).map((store) => store))
}

/**
 * 按时间清理接续段保留的 object store。封箱时冻结的结束状态会保留到下一次真实提问，
 * 用户直接关掉会话时这条链就再也没有下一次 —— 那些目录不会自己消失。
 * 只扫 `runtime/<provider>/<session>/segment-captures/<generation>` 这一层，
 * 会话仍在引用的目录和比保留期新的目录都不动。
 */
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
        // 目录自己的时间就是最后写入时间；比保留期新的写一半的目录留给下一轮。
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

/**
 * 按天清理过期的 `.tmp`。提交是唯一已知的收敛点（App 托管路径与独立 CLI 都走 `commitRecord`），
 * 所以它负责这件事；标记文件让目录遍历最多每天发生一次，而不是加在每条记录的关键路径上。
 * 任何一步失败都只是这次不清理：它绝不阻断提交。
 */
export async function pruneStaleTemps(
  dataRoot: string,
  options: { now?: number; olderThanMs?: number; retainedOlderThanMs?: number } = {}
): Promise<StaleTempPruneResult> {
  const now = options.now ?? Date.now()
  const ageMs = options.olderThanMs ?? STALE_TEMP_AGE_MS
  // 标记文件也不能穿过符号链接写出去：`runtime` 不是真实目录时退到数据根，仍然只在 `.scry/` 里。
  const runtime = await realDir(join(dataRoot, 'runtime'))
  const markerPath = runtime ? join(runtime, MARKER) : join(dataRoot, MARKER)
  const marker = await readJson<{ at?: unknown }>(markerPath)
  if (typeof marker?.at === 'string' && now - Date.parse(marker.at) < ageMs) {
    return { removed: 0, bytes: 0, scanned: false, retained: 0 }
  }
  const result: StaleTempPruneResult = { removed: 0, bytes: 0, scanned: true, retained: 0 }
  const cutoff = now - ageMs
  // 数据根只扫它自己这一层的临时文件：往下一层就是 `content/`（几十万个 blob）和 `archive/`
  // （历史证据），既不产生这类临时文件，也不该为了清理临时文件去遍历。
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
