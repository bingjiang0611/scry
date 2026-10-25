import { realpath } from 'node:fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import { DIFF_COMMIT_LIMIT, type DiffCommitPage, type DiffCommitSnapshot, type DiffRangeRequest } from '../shared/diff-history.js'
import { workspaceDiffCopy } from '../shared/constants/copy.js'
import { readDiffCommits, readDiffCommitSnapshot } from '../core/turn-recorder/git-diff-history.js'

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
function range(input: unknown): DiffRangeRequest & Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(workspaceDiffCopy.invalidHistoryRequest)
  const value = input as Record<string, unknown>
  if (typeof value.cwd !== 'string' || !value.cwd || typeof value.head !== 'string' || !SHA.test(value.head)
    || typeof value.baseCommit !== 'string' || !SHA.test(value.baseCommit)) throw new Error(workspaceDiffCopy.invalidHistoryRequest)
  return { cwd: value.cwd, head: value.head, baseCommit: value.baseCommit, offset: value.offset, commit: value.commit }
}

export function registerGitDiffHistoryIpc(
  register: (channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown) => void,
  authorizeDirectory: (cwd: string) => string
): void {
  const pending = new Map<string, Promise<DiffCommitPage | DiffCommitSnapshot>>()
  const read = (key: string, load: () => Promise<DiffCommitPage | DiffCommitSnapshot>): Promise<DiffCommitPage | DiffCommitSnapshot> => {
    const prior = pending.get(key)
    if (prior) return prior
    if (pending.size >= 4) throw new Error(workspaceDiffCopy.historyBusy)
    const request = load().finally(() => pending.delete(key))
    pending.set(key, request)
    return request
  }
  register('agent:gitDiffCommits', async (_event, input) => {
    const value = range(input)
    if (typeof value.offset !== 'number' || !Number.isInteger(value.offset) || value.offset < 0 || value.offset >= DIFF_COMMIT_LIMIT) {
      throw new Error(workspaceDiffCopy.invalidHistoryRequest)
    }
    const request = { cwd: await realpath(authorizeDirectory(value.cwd)), head: value.head, baseCommit: value.baseCommit, offset: value.offset }
    return read(JSON.stringify(['commits', request]), () => readDiffCommits(request))
  })
  register('agent:gitCommitDiffSnapshot', async (_event, input) => {
    const value = range(input)
    if (typeof value.commit !== 'string' || !SHA.test(value.commit)) throw new Error(workspaceDiffCopy.invalidHistoryRequest)
    const request = { cwd: await realpath(authorizeDirectory(value.cwd)), head: value.head, baseCommit: value.baseCommit, commit: value.commit }
    return read(JSON.stringify(['commit', request]), () => readDiffCommitSnapshot(request))
  })
}
