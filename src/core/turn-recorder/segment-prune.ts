import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import type { ProviderId } from '../../shared/provider.js'
import {
  recorderOpenPath, recorderStatePath, withRecorderSessionKeyLock, type RecorderSessionState
} from './runtime-state.js'

/**
 * 段链的 object store 只在「下一段拿它当基线」时有用。正常由真实提问开新链时整条释放
 * （`releaseSegmentChain`）；用户直接关掉会话、或会话被放弃时没有这个收敛点，store 会一直
 * 留在磁盘上。所以按时间清理：会话没有未完成轮次，且新的一段已经超过阈值没再出现，
 * 这条链就不会再被任何一段用到。
 *
 * 72 小时是「后台任务还能跑多久」的上限估计，不是精确语义：真到了这个年龄，宁可让下一段
 * 如实标 `no_baseline`，也不要无限期留着已经无关的字节。
 */
export const STALE_SEGMENT_CHAIN_AGE_MS = 72 * 60 * 60 * 1_000

const MARKER = 'stale-segment-prune.json'
const SEGMENTS = 'segment-captures'

export interface StaleSegmentPruneResult {
  /** 本次清掉的会话数（一个会话的一条链）。 */
  sessions: number
  generations: number
  files: number
  bytes: number
  /** 每天只真正扫描一次；其余调用直接返回 `scanned: false`。 */
  scanned: boolean
}

/** 只按目录直觉读取：沿符号链接清理会删到会话目录之外的字节。 */
async function realDir(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => null)
  return info?.isDirectory() === true ? path : undefined
}

async function dirsIn(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/**
 * 一段开始时建立自己的 store 目录，之后的重算复用同一个目录：目录的修改时间就是这一段
 * 出现的时间。对象写入发生在它下面的 `objects/`，不会把时间推后。
 */
async function newestGenerationMs(dir: string): Promise<number> {
  let newest = 0
  for (const name of await dirsIn(dir)) {
    const info = await stat(join(dir, name)).catch(() => null)
    if (info) newest = Math.max(newest, info.mtimeMs)
  }
  return newest
}

/**
 * 按天清理过期的段链并存。与 `.tmp` 清理一样挂在提交与常驻进程启动这两个收敛点上，
 * 任何一步失败都只是这次不清理，绝不阻断提交或 hook。
 */
export async function pruneStaleSegmentChains(
  dataRoot: string,
  options: { now?: number; olderThanMs?: number } = {}
): Promise<StaleSegmentPruneResult> {
  const now = options.now ?? Date.now()
  const ageMs = options.olderThanMs ?? STALE_SEGMENT_CHAIN_AGE_MS
  const result: StaleSegmentPruneResult = { sessions: 0, generations: 0, files: 0, bytes: 0, scanned: false }
  const runtime = await realDir(join(dataRoot, 'runtime'))
  if (runtime === undefined) return result
  const markerPath = join(runtime, MARKER)
  const marker = await readJson<{ at?: unknown }>(markerPath)
  if (typeof marker?.at === 'string' && now - Date.parse(marker.at) < ageMs) return result
  result.scanned = true
  const cutoff = now - ageMs
  for (const provider of await dirsIn(runtime)) {
    for (const sessionKey of await dirsIn(join(runtime, provider))) {
      const root = join(runtime, provider, sessionKey)
      const segments = await realDir(join(root, SEGMENTS))
      if (segments === undefined) continue
      // 未完成的轮次（包括挂着静默窗口的封箱）还会拿这条链当基线，绝不能在它下面删目录。
      if (await lstat(recorderOpenPath(root)).then(() => true).catch(() => false)) continue
      const newest = await newestGenerationMs(segments)
      if (newest === 0 || newest > cutoff) continue
      // 目录名就是 Provider id：`runtime/<provider>/<sessionKey>` 由 recorder 自己写出来。
      await withRecorderSessionKeyLock(dataRoot, provider as ProviderId, sessionKey, async () => {
        // 拿到锁后重判：这期间可能刚开了一个新轮次，或刚写进新的一段。
        if (await lstat(recorderOpenPath(root)).then(() => true).catch(() => false)) return
        const rechecked = await newestGenerationMs(segments)
        if (rechecked === 0 || rechecked > cutoff) return
        const generations = (await dirsIn(segments)).length
        let files = 0
        let bytes = 0
        for (const relative of await readdir(segments, { recursive: true }).catch(() => [])) {
          const info = await stat(join(segments, relative)).catch(() => null)
          if (!info?.isFile()) continue
          files++
          bytes += info.size
        }
        await rm(segments, { recursive: true, force: true })
        // 状态里指向这些字节的只有链与最后一段的冻结基线：一起清掉，下一段才会如实标
        // no_baseline，而不是读到一条指向空目录的引用。
        const state = await readJson<RecorderSessionState>(recorderStatePath(root))
        if (state && (state.chainStores !== undefined || state.lastSegment?.frozenDiffs !== undefined)) {
          delete state.chainStores
          if (state.lastSegment) delete state.lastSegment.frozenDiffs
          await writeJsonAtomic(recorderStatePath(root), state, { sync: false })
        }
        result.sessions++
        result.generations += generations
        result.files += files
        result.bytes += bytes
      }, { waitMs: 0 }).catch(() => undefined)
    }
  }
  await writeJsonAtomic(markerPath, { at: new Date(now).toISOString() })
  return result
}
