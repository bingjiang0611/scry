import { createHash } from 'node:crypto'
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { WorkspaceBranchRef, WorkspaceCheckoutProgress } from '../../shared/workspace-selection'
import { readConfig, readOnly, type GitIdentity, type ScGit } from './git'
import { scMessage } from './process'
import { readWorktreeChoices } from './workspace-choices'

/** Refs from the picker are frozen names + object identities, not revision expressions. */
export async function resolveWorkspaceRef(git: ScGit, identity: GitIdentity, ref: WorkspaceBranchRef): Promise<string> {
  const prefix = ref.kind === 'local' ? 'refs/heads/' : 'refs/remotes/'
  if (!ref.name.startsWith(prefix)) throw new Error('无效的起始分支')
  await git.run(identity.root, ['check-ref-format', ref.name])
  const actual = (await git.run(identity.root, ['rev-parse', '--verify', `${ref.name}^{commit}`])).trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(actual)) throw new Error('所选分支指向的对象不是提交')
  return actual
}

/** Switches and checkouts reuse the frozen identity; the ref must still be the reviewed commit. */
export async function verifyWorkspaceRef(git: ScGit, identity: GitIdentity, ref: WorkspaceBranchRef): Promise<void> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref.head)) throw new Error('无效的起始分支')
  if (await resolveWorkspaceRef(git, identity, ref) !== ref.head)
    throw new Error('所选分支已变化，请重新读取并确认起点')
}

/**
 * Inspect target-tree attributes with a private index. Looking only at the source
 * checkout misses filters introduced by the branch we are about to materialize.
 * Neither read-tree nor check-attr runs content filters; native write hooks are
 * separately refused by SourceControlService's action blocker.
 */
export async function assertWorkspaceCheckoutSafe(git: ScGit, identity: GitIdentity, head: string): Promise<void> {
  const tree = await git.run(identity.root, ['ls-tree', '-r', '-z', '--full-tree', head])
  const rows = tree.split('\0').filter(Boolean)
  if (rows.some(row => row.startsWith('160000 ')))
    throw new Error('目标分支包含子模块；不会自动初始化或递归执行子模块配置')
  const names = rows.map(row => row.slice(row.indexOf('\t') + 1)).join('\0')
  if (!names) return
  const directory = await mkdtemp(join(tmpdir(), 'scry-workspace-attributes-'))
  const gitIndexFile = join(directory, 'index')
  try {
    await git.process.run('git', [...readConfig, ...readOnly, 'read-tree', head], identity.root, { gitIndexFile })
    const attributes = await git.process.run('git', [
      ...readConfig, ...readOnly, 'check-attr', '--cached', '-z', '--stdin', 'filter'
    ], identity.root, { gitIndexFile, input: names + '\0' })
    const fields = attributes.split('\0')
    const drivers = new Set<string>()
    for (let index = 2; index < fields.length; index += 3) {
      const driver = fields[index]
      if (driver === 'unspecified' || driver === 'unset' || driver === 'set') continue
      drivers.add(driver)
    }
    // 没有 filter driver 时不必再读整份 config：多一次 git 进程启动就多几百毫秒。
    if (drivers.size === 0) return
    const config = new Map((await git.run(identity.root, ['config', '--null', '--list', '--includes']))
      .split('\0').filter(Boolean).map(row => {
        const separator = row.indexOf('\n')
        return separator < 0 ? [row, 'true'] : [row.slice(0, separator), row.slice(separator + 1)]
      }))
    for (const driver of drivers) {
      if (['clean', 'smudge', 'process'].some(kind => config.get(`filter.${driver}.${kind}`)) ||
        /^(?:true|yes|on|1)$/i.test(config.get(`filter.${driver}.required`) ?? ''))
        throw new Error(`目标分支需要原生 filter ${driver}；不会在准备工作区时执行该程序，请在终端处理`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function switchWorkspaceBranch(git: ScGit, identity: GitIdentity, ref: WorkspaceBranchRef): Promise<void> {
  if (ref.kind !== 'local') throw new Error('远端跟踪分支只能用作新分支的起点')
  await git.run(identity.root, [
    ...readOnly, '-c', 'submodule.recurse=false',
    'switch', '--no-guess', '--', ref.name.slice('refs/heads/'.length)
  ], false)
}

const CHECKOUT_PROGRESS_RE = /Updating files:\s*(\d{1,3})%\s*\((\d+)\/(\d+)\)/g

/** Parse real Git `checkout --progress` stderr output; returns null if no valid progress line is present. */
export function parseGitCheckoutProgress(text: string): WorkspaceCheckoutProgress | null {
  let latest: WorkspaceCheckoutProgress | null = null
  CHECKOUT_PROGRESS_RE.lastIndex = 0
  for (const match of text.matchAll(CHECKOUT_PROGRESS_RE)) {
    const percent = Number(match[1])
    const completed = Number(match[2])
    const total = Number(match[3])
    if (!Number.isSafeInteger(percent) || !Number.isSafeInteger(completed) || !Number.isSafeInteger(total)) continue
    if (total <= 0 || completed < 0 || completed > total) continue
    latest = { completed, total, percent: Math.max(0, Math.min(100, percent)) }
  }
  return latest
}

export interface CreateWorkspaceWorktreeOptions {
  signal?: AbortSignal
  onMetadataReady?: () => void
  onCheckoutProgress?: (progress: WorkspaceCheckoutProgress) => void
  onDetail?: (line: string) => void
}

function forwardSanitizedStderrLines(chunk: string, onDetail?: (line: string) => void): void {
  if (!onDetail) return
  for (const raw of chunk.split(/[\r\n]+/)) {
    const trimmed = raw.trim()
    if (!trimmed || CHECKOUT_PROGRESS_RE.test(trimmed)) {
      CHECKOUT_PROGRESS_RE.lastIndex = 0
      continue
    }
    CHECKOUT_PROGRESS_RE.lastIndex = 0
    onDetail(scMessage(trimmed).slice(0, 300))
  }
}

export async function createWorkspaceWorktree(
  git: ScGit, identity: GitIdentity, path: string, branch: string, head: string,
  options: CreateWorkspaceWorktreeOptions = {}
): Promise<void> {
  // Single `git worktree add` with `GIT_PROGRESS_DELAY=0` keeps worktree metadata and
  // checkout atomic (no half-created `--no-checkout` crash window) while emitting both
  // `Preparing worktree (...)` and real `Updating files: XX% (n/m)` lines on stderr.
  let metadataReady = false
  let stderrCarry = ''
  const markMetadataReady = (): void => {
    if (metadataReady) return
    metadataReady = true
    options.onMetadataReady?.()
  }
  await git.run(identity.root, [
    ...readOnly, '-c', 'submodule.recurse=false',
    'worktree', 'add', '--no-track', '-b', branch, '--', path, head
  ], false, 120_000, options.signal, {
    progressDelayZero: true,
    onStderrChunk: (chunk) => {
      const combined = `${stderrCarry}${chunk}`
      const lastBreak = Math.max(combined.lastIndexOf('\r'), combined.lastIndexOf('\n'))
      const complete = lastBreak >= 0 ? combined.slice(0, lastBreak + 1) : combined
      stderrCarry = lastBreak >= 0 ? combined.slice(lastBreak + 1).slice(-256) : combined.slice(-256)
      const parsed = parseGitCheckoutProgress(complete) ?? parseGitCheckoutProgress(chunk)
      if (parsed) {
        markMetadataReady()
        options.onCheckoutProgress?.(parsed)
      } else if (/Preparing worktree/i.test(complete) || /Preparing worktree/i.test(chunk)) {
        markMetadataReady()
      }
      forwardSanitizedStderrLines(complete, options.onDetail)
    }
  })
  markMetadataReady()
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Bounded cleanup for a Scry-owned worktree whose creation was explicitly cancelled
 * before Provider handoff. Never deletes paths outside `<userData>/worktrees/<repoHash>`
 * and never deletes a branch that moved off the base commit or is checked out elsewhere.
 */
export async function cleanupAbortedWorkspaceWorktree(
  git: ScGit, identity: GitIdentity, path: string, branchRef: string, baseHead: string, userData: string
): Promise<{ cleaned: true } | { cleaned: false; reason: string }> {
  try {
    const root = await realpath(userData)
    const repoDir = join(root, 'worktrees', createHash('sha256').update(identity.commonDir).digest('hex'))
    const rel = relative(repoDir, path)
    if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { cleaned: false, reason: '目标路径不在宿主托管的 worktrees 目录内' }
    }
    // `git worktree add` holds an `initializing` lock until checkout completes; killing it
    // mid-flight leaves that lock behind, so double `--force` is required to remove it.
    try {
      await git.run(identity.root, [...readOnly, 'worktree', 'remove', '--force', '--force', '--', path], false, 30_000)
    } catch {
      try {
        await git.run(identity.root, [...readOnly, 'worktree', 'unlock', '--', path], false, 30_000)
      } catch {
        // Worktree may not be locked or may already be partially gone.
      }
      try {
        await git.run(identity.root, [...readOnly, 'worktree', 'remove', '--force', '--force', '--', path], false, 30_000)
      } catch {
        // Directory or worktree registration may be partial after SIGKILL; follow up below.
      }
    }
    await rm(path, { recursive: true, force: true })
    await git.run(identity.root, [...readOnly, 'worktree', 'prune', '--expire=now'], false, 30_000)

    const branchName = branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : ''
    if (branchName) {
      const refLine = (await git.run(identity.root, [
        'for-each-ref', '--count=1', '--format=%(objectname)', branchRef
      ])).trim()
      if (refLine) {
        if (refLine !== baseHead) {
          return { cleaned: false, reason: '新建分支已不再指向初始基准提交，已停止自动清理' }
        }
        const trees = await readWorktreeChoices(git, identity)
        if (trees.some(tree => tree.branchRef === branchRef)) {
          return { cleaned: false, reason: '新建分支仍被 worktree 引用，已停止自动清理' }
        }
        await git.run(identity.root, [...readOnly, 'branch', '-D', '--', branchName], false, 30_000)
      }
    }

    // Verify clean state: target path gone, branch gone, and no worktree registered at path.
    try {
      await lstat(path)
      return { cleaned: false, reason: '目标 worktree 目录仍然存在' }
    } catch (error) {
      if (!isMissing(error)) return { cleaned: false, reason: scMessage(error) }
    }
    if (branchName) {
      const remainingRef = (await git.run(identity.root, [
        'for-each-ref', '--count=1', '--format=%(refname)', branchRef
      ])).trim()
      if (remainingRef) return { cleaned: false, reason: '新建分支未能确认删除' }
    }
    const remainingTrees = await readWorktreeChoices(git, identity)
    if (remainingTrees.some(tree => tree.path === path)) {
      return { cleaned: false, reason: 'Git worktree 清单中仍保留目标登记' }
    }
    return { cleaned: true }
  } catch (error) {
    return { cleaned: false, reason: scMessage(error) }
  }
}
