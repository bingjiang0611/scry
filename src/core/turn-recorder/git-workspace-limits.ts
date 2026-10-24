import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { GitDeadlineError, gitCommand, snapshotGitArgs } from './git-command.js'

export const WORKSPACE_FILE_LIMIT = 1_000
export const WORKSPACE_UNTRACKED_BYTES = 16 * 1024 * 1024
export const WORKSPACE_PATCH_BYTES = 256 * 1024

export class WorkspaceReadUnavailable extends Error {
  constructor(readonly reason: 'workspace_limit' | 'workspace_attributes' | 'workspace_file_type' | 'workspace_index' | 'workspace_submodule') {
    super(reason)
  }
}

/** Workspace inspection has a fixed work budget; recorder captures keep their existing contract. */
export async function checkWorkspaceCaptureLimits(input: {
  repoRoot: string
  cwd: string
  head: string
  records: string[]
  pathspec: string[]
  excludedPaths: string[]
  deadline: number
}): Promise<void> {
  const { repoRoot, cwd, head, records, pathspec, excludedPaths, deadline } = input
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  const [flags, stagedAttributes] = await Promise.all([
    gitCommand(snapshotGitArgs([], ['ls-files', '-v', '-z', '--', ...pathspec]), { cwd: repoRoot, env, deadline }),
    gitCommand(snapshotGitArgs([], ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-z', head, '--', ':(glob)**/.gitattributes']), { cwd: repoRoot, env, deadline })
  ])
  if (flags.split('\0').some(record => /^[a-zS] /.test(record))) throw new WorkspaceReadUnavailable('workspace_index')
  if (stagedAttributes) throw new WorkspaceReadUnavailable('workspace_attributes')
  let count = 0
  let untrackedBytes = 0
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record.startsWith('# ')) continue
    const kind = record[0]
    const fields = record.split(' ')
    const path = kind === '?' ? record.slice(2)
      : kind === '1' ? fields.slice(8).join(' ')
        : kind === '2' ? fields.slice(9).join(' ')
          : kind === 'u' ? fields.slice(10).join(' ') : undefined
    if (kind === '2') index++ // Porcelain v2 has a second NUL-delimited rename path.
    if (path === undefined) throw new WorkspaceReadUnavailable('workspace_index')
    const absolute = resolve(repoRoot, path)
    const inScope = relative(cwd, absolute)
    if (inScope === '..' || inScope.startsWith(`..${sep}`) || isAbsolute(inScope)) continue
    if (excludedPaths.some(excluded => {
      const child = relative(excluded, absolute)
      return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
    })) continue
    if (++count > WORKSPACE_FILE_LIMIT) throw new WorkspaceReadUnavailable('workspace_limit')
    if (fields[2]?.startsWith('S')) throw new WorkspaceReadUnavailable('workspace_submodule')
    if (kind !== '?') continue
    if (Date.now() >= deadline) throw new GitDeadlineError('Workspace snapshot deadline exceeded')
    const info = await lstat(absolute)
    if (!info.isFile() && !info.isSymbolicLink()) throw new WorkspaceReadUnavailable('workspace_file_type')
    untrackedBytes += info.size
    if (untrackedBytes > WORKSPACE_UNTRACKED_BYTES) throw new WorkspaceReadUnavailable('workspace_limit')
  }
}
