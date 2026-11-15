import { isAbsolute, relative, sep } from 'node:path'
import type { TurnDiffExcludeEvidence } from '../../shared/turn-diff.js'
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
  /** 过滤排除路径后的文件列表；未跟踪文件超限时仍保留全部条目，只是不带正文。 */
  files: DiffFile[]
  /** 被排除路径过滤掉的文件：只记命中的声明路径和数量，正文既不读取也不收录。 */
  excluded: TurnDiffExcludeEvidence
}

interface ExclusionPrefix {
  /** 接入方写的原样路径，用于记录「排除了哪些路径」。 */
  declared: string
  /** 该路径在本仓库内的相对前缀；空字符串表示整个仓库。 */
  prefix: string
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

/**
 * 声明路径有两种来源：工作区配置里的相对路径，以及会话声明里的绝对路径。
 *
 * 绝对路径必须按**每个仓库自己的根**换算，否则一个仓库的路径会误伤另一个：排除 `run/` 时
 * 它下面检出的独立仓库（`run/stage3/.../workspace/repo`）仍是自己的仓库，那条声明不在它的
 * 根之下，因此一个文件都不排除。这也正是「排除运行目录不能丢掉其中的代码仓库」的实现点。
 */
function exclusionPrefixes(repoRoot: string, entries: string[]): ExclusionPrefix[] {
  const prefixes: ExclusionPrefix[] = []
  for (const declared of entries) {
    if (!isAbsolute(declared)) {
      const normalized = declared.replace(/^\.\//, '').replace(/\/+$/, '')
      if (normalized) prefixes.push({ declared, prefix: normalized })
      continue
    }
    const rel = relative(repoRoot, declared).split(sep).join('/')
    // 祖先目录属于外层仓库；对当前仓库它不排除任何文件。
    if (rel === '..' || rel.startsWith('../')) continue
    prefixes.push({ declared, prefix: rel.replace(/\/+$/, '') })
  }
  return prefixes
}

function matchesExclusion(relPath: string, prefix: string): boolean {
  // 空前缀只在声明的路径正好是仓库根时出现：整个仓库被排除。
  if (!prefix) return true
  return relPath === prefix || relPath.startsWith(`${prefix}/`)
}

/**
 * 按接入方声明和未跟踪文件体量决定这一轮 diff 记录什么。
 *
 * 排除的文件整条不进 `files`：它们既没有正文，也不占用清单。被省略正文的未跟踪文件保留清单
 * 条目并标 `patchStatus: unavailable` / `patchReason: policy`，聚合层因此把 diff 证据标成 partial。
 * 两种情况的文件数量都会写进记录，正文不会。
 */
export function applyTurnDiffFilePolicy(args: {
  files: DiffFile[]
  repoRoot: string
  diffExclude: string[]
  /** 本轮结束时仍未跟踪的文件绝对路径（与 DiffFile.path 同一形式）；`undefined` 表示未查询。 */
  untracked: Set<string> | undefined
  untrackedLimit?: number
}): TurnDiffFilePolicyResult {
  const prefixes = exclusionPrefixes(args.repoRoot, args.diffExclude)
  const kept: DiffFile[] = []
  const declared = new Set<string>()
  let excludedFiles = 0
  for (const file of args.files) {
    if (prefixes.length === 0) {
      kept.push(file)
      continue
    }
    const rel = repoRelative(args.repoRoot, file.path)
    const matched = prefixes.filter((entry) => matchesExclusion(rel, entry.prefix))
    if (matched.length === 0) {
      kept.push(file)
      continue
    }
    excludedFiles += 1
    for (const entry of matched) declared.add(entry.declared)
  }
  const files = kept
  const excluded: TurnDiffExcludeEvidence = { paths: [...declared].sort(), files: excludedFiles }
  if (!args.untracked?.size) return { files, excluded }
  const limit = args.untrackedLimit ?? UNTRACKED_PATCH_FILE_LIMIT
  const newUntracked = files.filter((file) =>
    file.change === 'added' && args.untracked!.has(file.path))
  if (newUntracked.length <= limit) return { files, excluded }
  const omitted = new Set(newUntracked.map((file) => file.path))
  return {
    excluded,
    files: files.map((file) => omitted.has(file.path)
      ? { ...file, patchStatus: 'unavailable' as const, patchReason: 'policy' as const }
      : file)
  }
}
