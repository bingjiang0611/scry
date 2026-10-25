import {
  promisify
} from 'node:util'
import {
  execFile
} from 'node:child_process'
import {
  type TurnDiffReason
} from '../../shared/trace.js'
import {
  stat,
  copyFile,
  utimes,
  rm
} from 'node:fs/promises'
import {
  join
} from 'node:path'

const pexecFile = promisify(execFile)

// Keep the pre-turn snapshot short because the Provider waits for it before starting.
// The post-turn snapshot runs after turnDone, so it can spend longer producing an exact diff
// without making the user wait for the Agent response.
export const TURN_DIFF_BEGIN_DEADLINE_MS = 5_000

export const TURN_DIFF_FINISH_DEADLINE_MS = 20_000

export const TURN_DIFF_PATCH_DEADLINE_MS = 2_000

export const TURN_DIFF_TARGETED_DEADLINE_MS = 5_000

export const TURN_DIFF_CANDIDATE_LIMIT = 1_000

const GIT_MAX_BUFFER = 16 * 1024 * 1024

export class GitDeadlineError extends Error {}

interface GitCommandOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  deadline: number
  allowExitOne?: boolean
}

export async function gitCommand(args: string[], options: GitCommandOptions): Promise<string> {
  const timeout = options.deadline - Date.now()
  if (timeout <= 0) throw new GitDeadlineError('Git snapshot deadline exceeded')
  try {
    const { stdout } = await pexecFile('git', args, {
      cwd: options.cwd,
      env: options.env,
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: GIT_MAX_BUFFER
    })
    return stdout
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
    const exitCode = (error as { code?: unknown }).code
    if (e.killed || e.signal === 'SIGKILL' || e.code === 'ETIMEDOUT') throw new GitDeadlineError('Git snapshot deadline exceeded')
    if (options.allowExitOne && exitCode === 1) return ''
    throw error
  }
}

export function reasonOf(error: unknown): TurnDiffReason {
  return error instanceof GitDeadlineError ? 'deadline' : 'git_error'
}

function filterDriverOverrides(config: string): string[] {
  const names = new Set<string>()
  for (const line of config.split('\n')) {
    const key = line.trim().split(/\s+/, 1)[0]
    const match = /^filter\.(.+)\.(?:clean|process|required)$/i.exec(key)
    if (match?.[1]) names.add(match[1])
  }
  return [...names].flatMap((name) => [
    '-c', `filter.${name}.clean=`,
    '-c', `filter.${name}.process=`,
    '-c', `filter.${name}.required=false`
  ])
}

export function snapshotGitArgs(filterOverrides: string[], command: string[]): string[] {
  return ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...filterOverrides, ...command]
}

export async function copyIndexWithTimestamps(source: string, target: string): Promise<void> {
  // Git 用 index mtime 判定 racy-clean。普通 copy 会把 mtime 改成“现在”，可能漏掉
  // 本轮开始前已存在、但尺寸/mtime 恰好与 index entry 相同的内容变化。
  const sourceStat = await stat(source)
  await copyFile(source, target)
  // 向下截到毫秒，宁可让 Git 多 hash 一次，也不能因浮点进位把副本写成“比源 index 更新”。
  await utimes(target, Math.floor(sourceStat.atimeMs) / 1_000, Math.floor(sourceStat.mtimeMs) / 1_000)
}

export async function loadSnapshotOverrides(cwd: string, tempDir: string, deadline: number, config?: string): Promise<string[]> {
  const filterConfig = config ?? await gitCommand(['config', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], {
    cwd,
    deadline,
    allowExitOne: true
  })
  return [...filterDriverOverrides(filterConfig), '-c', `core.hooksPath=${join(tempDir, 'hooks-disabled')}`]
}

export async function writeSnapshotTree(options: {
  cwd: string
  pathspec: string[]
  env: NodeJS.ProcessEnv
  deadline: number
  filterOverrides: string[]
  sourceIndex: string
  targetIndex: string
}): Promise<string> {
  const { cwd, pathspec, env, deadline, filterOverrides, sourceIndex, targetIndex } = options
  let copied = false
  try {
    await copyIndexWithTimestamps(sourceIndex, targetIndex)
    copied = true
  } catch {}

  try {
    // 从 HEAD 重建逻辑内容，清掉真实 index 中与观测无关的 staged/unmerged 状态；
    // really-refresh 再强制核对 assume-unchanged，避免它让 add 漏掉真实改动。
    await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', '--reset', 'HEAD']), { cwd, env, deadline })
    await gitCommand(snapshotGitArgs(filterOverrides, ['update-index', '--really-refresh']), {
      cwd,
      env,
      deadline,
      allowExitOne: true
    })
    await gitCommand(snapshotGitArgs(filterOverrides, ['add', '-A', '--', ...pathspec]), { cwd, env, deadline })
    return (await gitCommand(snapshotGitArgs(filterOverrides, ['write-tree']), { cwd, env, deadline })).trim()
  } catch (error) {
    if (!copied || error instanceof GitDeadlineError) throw error
    await rm(targetIndex, { force: true })
    await gitCommand(snapshotGitArgs(filterOverrides, ['read-tree', 'HEAD']), { cwd, env, deadline })
    await gitCommand(snapshotGitArgs(filterOverrides, ['add', '-A', '--', ...pathspec]), { cwd, env, deadline })
    return (await gitCommand(snapshotGitArgs(filterOverrides, ['write-tree']), { cwd, env, deadline })).trim()
  }
}
