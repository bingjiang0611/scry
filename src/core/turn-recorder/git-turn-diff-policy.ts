import { relative, sep } from 'node:path'
import type { DiffFile } from '../../shared/trace.js'

/**
 * 一轮里新增的未跟踪文件超过这个数量时，只保留文件清单，不逐个生成 patch。
 *
 * 依据：正常一轮改动的文件数量是个位到几十；本阈值按一次真实事故（570 个由流程生成的资料文件）
 * 取十分之一左右，并远低于传输信封上限。逐文件 patch 的成本是每个文件一次 Git 进程，570 个文件
 * 会让一轮的 diff 采集和记录体量都失去意义。低于阈值时保持原样（每个文件都有完整 patch），
 * 所以这是「超限转清单」的边界，不是常态降级。
 */
export const UNTRACKED_PATCH_FILE_LIMIT = 50

export interface TurnDiffFilePolicyResult {
  /** 过滤配置排除路径后的文件列表；未跟踪文件超限时仍保留全部条目，只是不带正文。 */
  files: DiffFile[]
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

function excludedByConfig(relPath: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    const normalized = prefix.replace(/^\.\//, '').replace(/\/+$/, '')
    if (!normalized) return false
    return relPath === normalized || relPath.startsWith(`${normalized}/`)
  })
}

/**
 * 按接入方声明和未跟踪文件体量决定这一轮 diff 记录什么。
 *
 * 两条规则都只改「正文是否收录」，不改文件清单：`files` 始终是完整的改动面，被省略正文的文件
 * 标 `patchStatus: unavailable` / `patchReason: policy`，聚合层因此把 diff 证据标成 partial。
 */
export function applyTurnDiffFilePolicy(args: {
  files: DiffFile[]
  repoRoot: string
  diffExclude: string[]
  /** 本轮结束时仍未跟踪的文件绝对路径（与 DiffFile.path 同一形式）；`undefined` 表示未查询。 */
  untracked: Set<string> | undefined
  untrackedLimit?: number
}): TurnDiffFilePolicyResult {
  const files = args.diffExclude.length === 0
    ? [...args.files]
    : args.files.filter((file) => !excludedByConfig(repoRelative(args.repoRoot, file.path), args.diffExclude))
  if (!args.untracked?.size) return { files }
  const limit = args.untrackedLimit ?? UNTRACKED_PATCH_FILE_LIMIT
  const newUntracked = files.filter((file) =>
    file.change === 'added' && args.untracked!.has(file.path))
  if (newUntracked.length <= limit) return { files }
  const omitted = new Set(newUntracked.map((file) => file.path))
  return {
    files: files.map((file) => omitted.has(file.path)
      ? { ...file, patchStatus: 'unavailable' as const, patchReason: 'policy' as const }
      : file)
  }
}
