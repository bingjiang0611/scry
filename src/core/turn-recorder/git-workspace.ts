import {
  type TurnDiffReason,
  type WorkspaceDiffResult
} from '../../shared/trace.js'
import {
  beginGitTurnDiff,
  capturePathspec
} from './git-capture.js'
import {
  gitCommand,
  snapshotGitArgs,
  TURN_DIFF_BEGIN_DEADLINE_MS,
  GitDeadlineError,
  loadSnapshotOverrides,
  copyIndexWithTimestamps,
  reasonOf
} from './git-command.js'
import {
  utf8Prefix,
  parseNumstat
} from './git-patches.js'
import {
  cancelGitTurnDiff
} from './git-lifecycle.js'
import {
  realpath,
  mkdtemp,
  lstat,
  readlink,
  open,
  rm
} from 'node:fs/promises'
import {
  resolve,
  relative,
  join
} from 'node:path'
import {
  tmpdir
} from 'node:os'
import {
  constants
} from 'node:fs'

// 「工作区未提交改动」= 当前工作树 vs HEAD，语义上独立于每轮 turn diff。
// 直接 `git diff HEAD` 会漏掉未跟踪新文件，所以复用 beginGitTurnDiff 的快照树：
// 它已经把 untracked（排除 ignored）用隔离 index/object dir 暂存成一棵 tree，不动真实 index。
export interface WorkspaceGitDiff {
  status: 'captured' | 'unavailable' | 'timeout' | 'failed'
  reason?: TurnDiffReason
  patch: string
  truncated: boolean
}

// A bounded current-worktree vs HEAD view, including untracked files. Reuse the
// isolated, filter-disabled snapshot; never refresh/write the user's real index.
// Unlike gitNumstat, failure is not an empty/clean diff. Huge output fails at the
// existing 16 MiB subprocess bound; the phone preview retains at most 64 KiB.
export async function readWorkspaceGitDiff(cwd: string): Promise<WorkspaceGitDiff> {
  const capture = await beginGitTurnDiff(cwd)
  try {
    if (capture.status !== 'ready' || !capture.repoRoot || !capture.beforeTree) {
      return { status: capture.status === 'ready' ? 'failed' : capture.status,
        reason: capture.reason ?? 'git_error', patch: '', truncated: false }
    }
    const patch = await gitCommand(snapshotGitArgs(capture.filterOverrides ?? [], [
      'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
      'HEAD', capture.beforeTree, '--', ...(capture.pathspec ?? ['.'])
    ]), {
      cwd: capture.repoRoot,
      env: { ...process.env, GIT_OBJECT_DIRECTORY: capture.objectDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs },
      deadline: Date.now() + TURN_DIFF_BEGIN_DEADLINE_MS
    })
    return { status: 'captured', patch: utf8Prefix(patch, 64 * 1024).value,
      truncated: Buffer.byteLength(patch) > 64 * 1024 }
  } catch (error) {
    return { status: error instanceof GitDeadlineError ? 'timeout' : 'failed',
      reason: error instanceof GitDeadlineError ? 'deadline' : 'git_error', patch: '', truncated: false }
  } finally {
    await cancelGitTurnDiff(capture)
  }
}

// Workspace-only limits. Exceeding one is unavailable, never a successful partial list.
import { WORKSPACE_FILE_LIMIT, WORKSPACE_UNTRACKED_BYTES, WorkspaceReadUnavailable } from './git-workspace-limits.js'

/** Read HEAD vs worktree without add/write-tree or an object store. Preserve index
 * stat hints in an isolated copy, then reset its contents to HEAD. Special index
 * flags are unavailable rather than silently changing the snapshot oracle's view. */
export async function readWorkspaceNumstat(
  cwd: string,
  excludedPaths: string[] = [],
  deadlineMs = TURN_DIFF_BEGIN_DEADLINE_MS
): Promise<WorkspaceDiffResult> {
  const started = Date.now()
  const collectedAt = new Date(started).toISOString()
  const deadline = started + deadlineMs
  let tempDir: string | undefined
  try {
    const canonicalCwd = await realpath(cwd)
    // Missing promisor objects must fail locally, not invoke repository-configured
    // remote helpers / core.sshCommand during an observational read.
    const readEnv = { ...process.env, GIT_NO_LAZY_FETCH: '1' }
    let layout: string
    try {
      layout = await gitCommand(['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-path', 'index', '--verify', 'HEAD'], {
        cwd: canonicalCwd, env: readEnv, deadline
      })
    } catch (error) {
      if (error instanceof GitDeadlineError) throw error
      // rev-parse emits the worktree layout before a missing HEAD error.
      const stdout = (error as { stdout?: string }).stdout ?? ''
      return { status: 'unavailable', reason: stdout.startsWith('true\n') ? 'no_head' : 'not_git', files: [], collectedAt }
    }
    const [inside, repoRoot, indexPath, head] = layout.trimEnd().split('\n')
    if (inside !== 'true' || !repoRoot || !head) return { status: 'unavailable', reason: 'not_git', files: [], collectedAt }
    const canonicalExclusions = await Promise.all(excludedPaths.map(async path => {
      try { return await realpath(path) } catch { return resolve(path) }
    }))
    const pathspec = capturePathspec(repoRoot, relative(repoRoot, canonicalCwd) || '.', canonicalExclusions)
    tempDir = await mkdtemp(join(tmpdir(), 'scry-workspace-numstat-'))
    // Fetch filter drivers and conversion settings together. The recorder's default
    // override loader is unchanged; this path supplies the already-read config keys.
    const configOutput = await gitCommand(['config', '--null', '--get-regexp', '^(filter\\..*\\.(clean|process|required)|core\\.(bigfilethreshold|autocrlf))$'], {
      cwd: repoRoot, env: readEnv, deadline, allowExitOne: true
    })
    const configEntries = configOutput.split('\0').filter(Boolean).map(record => {
      const separator = record.indexOf('\n')
      // A valueless Git boolean is true; --null omits its newline/value entirely.
      return separator < 0 ? [record, 'true'] as const : [record.slice(0, separator), record.slice(separator + 1)] as const
    })
    const config = new Map(configEntries.map(([key, value]) => [key.toLowerCase(), value]))
    // Filter subsection names are case-sensitive; only normalize lookup keys for core settings.
    const overrides = await loadSnapshotOverrides(repoRoot, tempDir, deadline, configEntries.map(([key]) => key).join('\n'))
    overrides.push('-c', 'core.splitIndex=false')
    const targetIndex = join(tempDir, 'index')
    try {
      await copyIndexWithTimestamps(resolve(canonicalCwd, indexPath), targetIndex)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const env = { ...readEnv, GIT_INDEX_FILE: targetIndex }
    const command = (args: string[]): Promise<string> => gitCommand(snapshotGitArgs(overrides, args), { cwd: repoRoot, env, deadline })
    const [flags, stagedAttributes] = await Promise.all([
      gitCommand(snapshotGitArgs(overrides, ['ls-files', '-v', '-z', '--', ...pathspec]), { cwd: repoRoot, env: readEnv, deadline }),
      gitCommand(snapshotGitArgs(overrides, ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-z', head, '--', ':(glob)**/.gitattributes']), { cwd: repoRoot, env: readEnv, deadline })
    ])
    // Worktree attributes fall back to the index. Resetting its staged attributes
    // would change that fallback, so do not claim equivalence for this case.
    if (stagedAttributes) throw new WorkspaceReadUnavailable('workspace_attributes')
    // The oracle's initial status can hide assume-unchanged edits, while its dirty
    // branch refreshes them. Do not silently choose either interpretation here.
    if (flags.split('\0').some(record => /^[a-zS] /.test(record))) throw new WorkspaceReadUnavailable('workspace_index')
    await command(['read-tree', '--reset', head])
    const [numstat, others] = await Promise.all([
      command(['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--raw', '--numstat', '-z', '--', ...pathspec]),
      command(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec])
    ])
    const records = numstat.split('\0')
    let recordIndex = 0
    while (records[recordIndex]?.startsWith(':')) {
      if (/^:(?:160000 |[0-7]{6} 160000 )/.test(records[recordIndex])) throw new WorkspaceReadUnavailable('workspace_submodule')
      recordIndex += 2 // --no-renames: one raw header and one literal path.
    }
    const files = parseNumstat(records.slice(recordIndex).join('\0'), repoRoot)
    const paths = others.split('\0').filter(Boolean)
    if (files.length + paths.length > WORKSPACE_FILE_LIMIT || Buffer.byteLength(others) > 128 * 1024) {
      throw new WorkspaceReadUnavailable('workspace_limit')
    }
    if (paths.length) {
      if (!['false', 'no', 'off', '0', ''].includes((config.get('core.autocrlf') ?? '').toLowerCase())) throw new WorkspaceReadUnavailable('workspace_attributes')
      const threshold = /^(\d+)([kmg]?)$/i.exec(config.get('core.bigfilethreshold') ?? '512m')
      if (!threshold) throw new WorkspaceReadUnavailable('workspace_attributes')
      const exponent = threshold[2] ? 'kmg'.indexOf(threshold[2].toLowerCase()) + 1 : 0
      const binaryThreshold = Number(threshold[1]) * 1024 ** exponent
      const attrs = (await command(['check-attr', '-z', 'diff', 'working-tree-encoding', 'text', 'eol', 'ident', '--', ...paths])).split('\0')
      const diffAttrs = new Map<string, string>()
      for (let index = 0; index + 2 < attrs.length; index += 3) {
        const [path, name, value] = attrs.slice(index, index + 3)
        if (['working-tree-encoding', 'text', 'eol', 'ident'].includes(name) && value !== 'unspecified' && value !== 'unset') {
          throw new WorkspaceReadUnavailable('workspace_attributes')
        }
        if (name === 'diff') {
          if (!['unspecified', 'set', 'unset'].includes(value)) throw new WorkspaceReadUnavailable('workspace_attributes')
          diffAttrs.set(path, value)
        }
      }
      let remaining = WORKSPACE_UNTRACKED_BYTES
      for (const path of paths) {
        if (Date.now() >= deadline) throw new GitDeadlineError('Git workspace deadline exceeded')
        const absolute = join(repoRoot, path)
        const metadata = await lstat(absolute)
        let content: Buffer
        if (metadata.isSymbolicLink()) {
          content = Buffer.from(await readlink(absolute))
        } else if (metadata.isFile()) {
          if (metadata.size > remaining) throw new WorkspaceReadUnavailable('workspace_limit')
          const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            // One extra byte detects growth beyond the total budget without readFile's unbounded allocation.
            const buffer = Buffer.alloc(metadata.size + 1)
            let length = 0
            while (length < buffer.length) {
              const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
              if (!bytesRead) break
              length += bytesRead
              if (Date.now() >= deadline) throw new GitDeadlineError('Git workspace deadline exceeded')
            }
            if (length > metadata.size) throw new Error('Workspace file changed during read')
            content = buffer.subarray(0, length)
          } finally { await handle.close() }
        } else {
          throw new WorkspaceReadUnavailable('workspace_file_type')
        }
        remaining -= content.length
        if (remaining < 0) throw new WorkspaceReadUnavailable('workspace_limit')
        const attribute = metadata.isSymbolicLink() ? 'set' : diffAttrs.get(path)
        const binary = attribute === 'unset' || (attribute !== 'set' && (content.length > binaryThreshold || content.subarray(0, 8000).includes(0)))
        let added = 0
        if (!binary && content.length) {
          for (let offset = content.indexOf(10); offset !== -1; offset = content.indexOf(10, offset + 1)) added++
          if (content[content.length - 1] !== 10) added++
        }
        files.push({ path: absolute, added, deleted: 0, ...(binary ? { binary: true } : {}) })
      }
    }
    if (Date.now() >= deadline) throw new GitDeadlineError('Git workspace deadline exceeded')
    files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    return { status: 'captured', files, collectedAt }
  } catch (error) {
    if (error instanceof WorkspaceReadUnavailable) return { status: 'unavailable', reason: error.reason, files: [], collectedAt }
    return { status: error instanceof GitDeadlineError ? 'timeout' : 'failed', reason: reasonOf(error), files: [], collectedAt }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}

export async function gitNumstat(cwd: string): Promise<WorkspaceDiffResult> {
  const capture = await beginGitTurnDiff(cwd)
  try {
    if (capture.status !== 'ready') {
      return { status: capture.status, reason: capture.reason ?? 'git_error', files: [] }
    }
    if (!capture.repoRoot || !capture.beforeTree) return { status: 'failed', reason: 'no_baseline', files: [] }
    if (capture.baselineClean) return { status: 'captured', files: [] }
    const stdout = await gitCommand(
      snapshotGitArgs(capture.filterOverrides ?? [], [
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        'HEAD',
        capture.beforeTree,
        '--',
        ...(capture.pathspec ?? ['.'])
      ]),
      {
        cwd: capture.repoRoot,
        env: {
          ...process.env,
          GIT_OBJECT_DIRECTORY: capture.objectDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: capture.alternateObjectDirs
        },
        deadline: Date.now() + TURN_DIFF_BEGIN_DEADLINE_MS
      }
    )
    return { status: 'captured', files: parseNumstat(stdout, capture.repoRoot) }
  } catch (error) {
    return { status: error instanceof GitDeadlineError ? 'timeout' : 'failed', reason: reasonOf(error), files: [] }
  } finally {
    await cancelGitTurnDiff(capture)
  }
}
