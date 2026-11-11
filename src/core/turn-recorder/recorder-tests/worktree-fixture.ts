import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import type { AgentTurnRecord } from '../../../shared/turn-record'
import type { TurnDiffSnapshotRecord } from '../../../shared/turn-record-contracts'
import { workspace, pexecFile, payload } from './fixture.test'

/**
 * worktree 用例共享的夹具：一个已提交基线的 Git 工作区 + 回合开始/收尾 + 记录断言。
 * `trees/` 被忽略，新建 worktree 不会混进父仓库的回合 diff。
 */
export async function gitWorkspace(nested = true, ignore = 'trees/\n'): Promise<string> {
  const root = await workspace()
  await pexecFile('git', ['init'], { cwd: root })
  await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
  await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
  await writeFile(join(root, '.gitignore'), ignore)
  await writeFile(join(root, 'a.txt'), 'before\n')
  await pexecFile('git', ['add', '.gitignore', 'a.txt'], { cwd: root })
  await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
  const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
  config.capture.diff = true
  // linked worktree 的发现只在 discover-nested-git 模式下开启（与现场一致）。
  config.repositories = nested ? { mode: 'discover-nested-git', maxDepth: 2 } : { mode: 'workspace-only' }
  await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
  return root
}

export function worktreePath(root: string, name: string): string {
  return join(root, 'trees', name)
}

export async function addWorktree(root: string, name: string, args: string[] = []): Promise<string> {
  const path = worktreePath(root, name)
  await pexecFile('git', ['worktree', 'add', ...args, '-b', `branch-${name}`, path], { cwd: root })
  return path
}

export async function startTurn(root: string, sessionId: string, timestamp = '2026-07-19T12:00:00.000Z'): Promise<void> {
  await handleRecorderHook({
    provider: 'opencode',
    event: 'chat.message',
    workspace: root,
    payload: payload(sessionId, { prompt: 'work in a new worktree', timestamp })
  })
}

export async function endTurn(root: string, sessionId: string, timestamp = '2026-07-19T12:00:01.000Z'): Promise<AgentTurnRecord> {
  await handleRecorderHook({
    provider: 'opencode',
    event: 'session.idle',
    workspace: root,
    payload: payload(sessionId, { timestamp })
  })
  const records = await listRecords(join(root, '.scry'))
  return records[records.length - 1]
}

export function diffAt(record: AgentTurnRecord, requestedRoot: string): TurnDiffSnapshotRecord {
  const match = record.diff.value?.find((snapshot) =>
    snapshot.requestedRoot === requestedRoot || snapshot.repoRoot === requestedRoot)
  if (!match) throw new Error(`no diff snapshot for ${requestedRoot}: ${JSON.stringify(record.diff.value?.map((s) => s.requestedRoot))}`)
  return match
}

export function summaries(record: AgentTurnRecord): string[] {
  return (record.diff.value ?? []).flatMap((snapshot) =>
    snapshot.files.map((file) => `${file.path}:+${file.added}/-${file.deleted}`))
}
