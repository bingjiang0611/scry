import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { finishNewWorktreeBaseline, readWorktreeCreation } from '../git-worktree-baseline'
import type { AgentTurnRecord } from '../../../shared/turn-record'
import { workspace, pexecFile, payload, roots } from './fixture.test'
import { addWorktree, diffAt, endTurn, gitWorkspace, startTurn, summaries, worktreePath } from './worktree-fixture'

export function registerSuite24(): void {

describe('本回合新建 worktree 的 diff 基线', () => {
  it('本轮新建并提交：diff 包含这些改动，来源标为 worktree-creation-reflog', async () => {
    const root = await gitWorkspace()
    const creationCommit = (await pexecFile('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
    await startTurn(root, 'wt-commit')
    const worktree = await addWorktree(root, 'wt')
    await writeFile(join(worktree, 'feature.txt'), 'first\nsecond\n')
    await pexecFile('git', ['add', 'feature.txt'], { cwd: worktree })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'feature work'], { cwd: worktree })
    const record = await endTurn(root, 'wt-commit')

    const canonicalWorktree = await realpath(worktree)
    const snapshot = diffAt(record, canonicalWorktree)
    expect(snapshot).toMatchObject({
      status: 'captured',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'available',
      baselineCommit: creationCommit
    })
    expect(Date.parse(snapshot.baselineCreatedAt!)).toBeGreaterThan(0)
    expect(snapshot.files).toEqual([
      expect.objectContaining({ path: join(canonicalWorktree, 'feature.txt'), added: 2, deleted: 0, change: 'added' })
    ])
    expect(record.diff).toMatchObject({ status: 'available', quality: 'exact' })
  }, 35_000)

  it('新建后只有未提交改动和未跟踪文件：全部计入', async () => {
    const root = await gitWorkspace()
    await startTurn(root, 'wt-dirty')
    const worktree = await addWorktree(root, 'dirty')
    await writeFile(join(worktree, 'a.txt'), 'after\n')
    await writeFile(join(worktree, 'untracked.txt'), 'new file\n')
    const record = await endTurn(root, 'wt-dirty')

    const canonicalWorktree = await realpath(worktree)
    const snapshot = diffAt(record, canonicalWorktree)
    expect(snapshot.status).toBe('captured')
    expect(snapshot.baselineStatus).toBe('available')
    expect(snapshot.files.map((file) => ({ path: file.path, added: file.added, deleted: file.deleted })).sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual([
        { path: join(canonicalWorktree, 'a.txt'), added: 1, deleted: 1 },
        { path: join(canonicalWorktree, 'untracked.txt'), added: 1, deleted: 0 }
      ])
  }, 35_000)

  it('本轮建了又删：partial 并写明 worktree 已被删除，不编造 diff', async () => {
    const root = await gitWorkspace()
    const canonicalRoot = await realpath(root)
    await startTurn(root, 'wt-deleted')
    const worktree = await addWorktree(root, 'gone')
    await writeFile(join(worktree, 'work.txt'), 'will vanish\n')
    await rm(worktree, { recursive: true, force: true })
    const record = await endTurn(root, 'wt-deleted')

    // Git 在 gitdir 记录里写的是 canonical 路径，所以已删除的 worktree 仍能报出它的路径。
    const snapshot = diffAt(record, join(canonicalRoot, 'trees', 'gone'))
    expect(snapshot).toMatchObject({
      status: 'unavailable',
      reason: 'no_baseline',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'partial',
      baselineReason: 'worktree_deleted',
      files: []
    })
    expect(record.diff.status).toBe('partial')
  }, 35_000)

  it('worktree 的 .git 链接被删掉：partial，不把整个目录算成新增文件', async () => {
    // 少了 `<root>/.git`，Git 会向上解析到外层仓库，把 worktree 里每个文件都当成新增。
    const root = await gitWorkspace()
    await startTurn(root, 'wt-link-gone')
    const worktree = await addWorktree(root, 'link-gone')
    await writeFile(join(worktree, 'kept.txt'), 'left behind\n')
    await rm(join(worktree, '.git'), { force: true })
    const record = await endTurn(root, 'wt-link-gone')

    const snapshot = diffAt(record, await realpath(worktree))
    expect(snapshot).toMatchObject({
      status: 'unavailable',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'partial',
      baselineReason: 'worktree_deleted',
      files: []
    })
    expect(record.diff.status).toBe('partial')
  }, 35_000)

  it('--no-checkout 创建：partial 并写明没有确定的检出内容', async () => {
    const root = await gitWorkspace()
    await startTurn(root, 'wt-no-checkout')
    const worktree = await addWorktree(root, 'nocheckout', ['--no-checkout'])
    await writeFile(join(worktree, 'stray.txt'), 'not from a checkout\n')
    const record = await endTurn(root, 'wt-no-checkout')

    const snapshot = diffAt(record, await realpath(worktree))
    expect(snapshot).toMatchObject({
      status: 'unavailable',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'partial',
      baselineReason: 'no_checkout',
      files: []
    })
    expect(record.diff.status).toBe('partial')
  }, 35_000)

  it('reflog 关闭：partial 并写明原因，不出现编造的 diff', async () => {
    const root = await gitWorkspace()
    await startTurn(root, 'wt-no-reflog')
    const worktree = worktreePath(root, 'noreflog')
    await pexecFile('git', ['-c', 'core.logAllRefUpdates=false', 'worktree', 'add', '-b', 'branch-noreflog', worktree], { cwd: root })
    await writeFile(join(worktree, 'a.txt'), 'unattributable\n')
    const record = await endTurn(root, 'wt-no-reflog')

    const snapshot = diffAt(record, await realpath(worktree))
    expect(snapshot).toMatchObject({
      status: 'unavailable',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'partial',
      baselineReason: 'reflog_missing',
      files: []
    })
    expect(record.diff.status).toBe('partial')
    expect(record.diff.omissionReason).toContain('reflog_missing')
  }, 35_000)

  it('时钟异常（创建时间晚于收尾上限）：仍记 partial，原因保留', async () => {
    const root = await gitWorkspace()
    await startTurn(root, 'wt-skew')
    const worktree = await addWorktree(root, 'skew')
    const gitDir = (await pexecFile('git', ['rev-parse', '--absolute-git-dir'], { cwd: worktree })).stdout.trim()
    const reflogPath = join(gitDir, 'logs', 'HEAD')
    const [first, ...rest] = (await readFile(reflogPath, 'utf8')).split('\n')
    const [header, ...message] = first.split('\t')
    const meta = header.split(' ')
    // 收尾上限允许 60s 时钟偏移；把创建时间推到 1 小时后只会来自时钟或 reflog 异常。
    meta.splice(meta.length - 2, 1, String(Math.floor(Date.now() / 1_000) + 3_600))
    await writeFile(reflogPath, [[meta.join(' '), ...message].join('\t'), ...rest].join('\n'))
    const record = await endTurn(root, 'wt-skew')

    expect(diffAt(record, await realpath(worktree))).toMatchObject({
      status: 'unavailable',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'partial',
      baselineReason: 'reflog_outside_turn',
      files: []
    })
    expect(record.diff.status).toBe('partial')
  }, 35_000)

  it('上一轮建的 worktree 在下一轮按普通基线处理，不重复计算', async () => {
    const root = await gitWorkspace()
    await startTurn(root, 'wt-two-turns')
    const worktree = await addWorktree(root, 'carry')
    await writeFile(join(worktree, 'first.txt'), 'turn one\n')
    await pexecFile('git', ['add', 'first.txt'], { cwd: worktree })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'first turn work'], { cwd: worktree })
    const first = await endTurn(root, 'wt-two-turns')
    const canonicalWorktree = await realpath(worktree)
    expect(diffAt(first, canonicalWorktree)).toMatchObject({
      status: 'captured',
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'available'
    })

    await startTurn(root, 'wt-two-turns', '2026-07-19T12:01:00.000Z')
    await writeFile(join(worktree, 'second.txt'), 'turn two\n')
    const second = await endTurn(root, 'wt-two-turns', '2026-07-19T12:01:01.000Z')
    const carried = diffAt(second, canonicalWorktree)
    expect(carried.status).toBe('captured')
    expect(carried).not.toHaveProperty('baselineSource')
    // 只含第二轮自己的改动：上一轮的 first.txt 不再重复出现。
    expect(carried.files).toEqual([
      expect.objectContaining({ path: join(canonicalWorktree, 'second.txt'), added: 1, deleted: 0 })
    ])
    expect(summaries(second).some((entry) => entry.includes('first.txt'))).toBe(false)
  }, 35_000)

  it('.worktrees/ 这类点目录不被跳过：下一轮按普通基线纳入', async () => {
    const root = await gitWorkspace(true, 'trees/\n.worktrees/\n')
    await startTurn(root, 'wt-dot')
    const worktree = join(root, '.worktrees', 'dot')
    await pexecFile('git', ['worktree', 'add', '-b', 'branch-dot', worktree], { cwd: root })
    await writeFile(join(worktree, 'dot.txt'), 'turn one\n')
    const first = await endTurn(root, 'wt-dot')
    const canonical = await realpath(worktree)
    expect(diffAt(first, canonical)).toMatchObject({
      status: 'captured',
      baselineSource: 'worktree-creation-reflog'
    })

    await startTurn(root, 'wt-dot', new Date().toISOString())
    await writeFile(join(worktree, 'dot.txt'), 'turn one\nturn two\n')
    const second = await endTurn(root, 'wt-dot', new Date().toISOString())
    const carried = diffAt(second, canonical)
    expect(carried.status).toBe('captured')
    expect(carried).not.toHaveProperty('baselineSource')
    expect(carried.files).toEqual([
      expect.objectContaining({ path: join(canonical, 'dot.txt'), added: 1, deleted: 0 })
    ])
  }, 45_000)

  it('一轮新建 9 个：8 个有 diff，第 9 个 partial（超出每轮上限）', async () => {
    const root = await gitWorkspace()
    await startTurn(root, 'wt-nine')
    const worktrees: string[] = []
    for (let index = 1; index <= 9; index++) {
      const worktree = await addWorktree(root, `wt-${index}`)
      await writeFile(join(worktree, `part-${index}.txt`), `part ${index}\n`)
      await pexecFile('git', ['add', `part-${index}.txt`], { cwd: worktree })
      await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', `part ${index}`], { cwd: worktree })
      worktrees.push(await realpath(worktree))
    }
    const record = await endTurn(root, 'wt-nine')

    const captured = worktrees.filter((worktree) => {
      const snapshot = diffAt(record, worktree)
      return snapshot.status === 'captured'
    })
    const limited = worktrees.filter((worktree) => {
      const snapshot = diffAt(record, worktree)
      return snapshot.baselineReason === 'per_turn_limit'
    })
    expect(captured).toHaveLength(8)
    expect(limited).toHaveLength(1)
    expect(diffAt(record, limited[0])).toMatchObject({ status: 'unavailable', files: [], baselineStatus: 'partial' })
    expect(record.diff.status).toBe('partial')
    expect(record.diff.omissionReason).toContain('per_turn_limit')
  }, 60_000)

  it('workspace 采集范围外的新 worktree：不记录', async () => {
    const root = await gitWorkspace()
    const outside = await mkdtemp(join(tmpdir(), 'scry-worktree-outside-'))
    roots.push(outside)
    await startTurn(root, 'wt-outside')
    await pexecFile('git', ['worktree', 'add', '-b', 'branch-outside', join(outside, 'wt')], { cwd: root })
    await writeFile(join(outside, 'wt', 'outside.txt'), 'out of scope\n')
    const record = await endTurn(root, 'wt-outside')

    expect((record.diff.value ?? []).some((snapshot) => snapshot.requestedRoot?.includes('scry-worktree-outside-'))).toBe(false)
    expect(record.diff.value).toHaveLength(1)
    expect(record.diff.value?.[0].requestedRoot).toBe(root)
  }, 35_000)

  it('Codex 现场形态：第 5 轮新建并写入、第 6 轮继续，各轮只算自己的改动', async () => {
    const root = await gitWorkspace()
    const rollout = join(root, 'rollout.jsonl')
    const turn = (turnId: string, startedAt: string, completedAt: string) => [
      { timestamp: startedAt, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { timestamp: startedAt, type: 'event_msg', payload: { type: 'user_message', message: turnId } },
      { timestamp: completedAt, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }
    ]
    const hook = async (event: string, turnId: string, timestamp: string): Promise<void> => {
      await writeFile(rollout, `${turn(turnId, timestamp, timestamp).map((line) => JSON.stringify(line)).join('\n')}\n`)
      await handleRecorderHook({
        provider: 'codex',
        event,
        workspace: root,
        payload: payload('codex-worktree', { prompt: turnId, turn_id: turnId, rollout_path: rollout, timestamp })
      })
    }

    await hook('turn.started', 'turn-5', '2026-07-19T12:00:00.000Z')
    const worktree = await addWorktree(root, 'business')
    await writeFile(join(worktree, 'business.txt'), 'line one\nline two\n')
    await pexecFile('git', ['add', 'business.txt'], { cwd: worktree })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'business change'], { cwd: worktree })
    await hook('turn/completed', 'turn-5', '2026-07-19T12:00:01.000Z')

    await hook('turn.started', 'turn-6', '2026-07-19T12:01:00.000Z')
    await writeFile(join(worktree, 'business.txt'), 'line one\nline two\nline three\n')
    await hook('turn/completed', 'turn-6', '2026-07-19T12:01:01.000Z')

    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(2)
    const canonicalWorktree = await realpath(worktree)
    expect(diffAt(records[0], canonicalWorktree)).toMatchObject({
      status: 'captured',
      baselineSource: 'worktree-creation-reflog',
      files: [expect.objectContaining({ path: join(canonicalWorktree, 'business.txt'), added: 2, deleted: 0 })]
    })
    expect(diffAt(records[1], canonicalWorktree)).toMatchObject({
      status: 'captured',
      files: [expect.objectContaining({ path: join(canonicalWorktree, 'business.txt'), added: 1, deleted: 0 })]
    })
    expect(diffAt(records[1], canonicalWorktree)).not.toHaveProperty('baselineSource')
  }, 45_000)
})

describe('worktree reflog 创建记录解析', () => {
  async function reflogFixture(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'scry-reflog-'))
    roots.push(dir)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(dir, 'logs')))
    await writeFile(join(dir, 'logs', 'HEAD'), content)
    return dir
  }

  it('取第一条旧值全 0 的记录作为创建提交', async () => {
    const dir = await reflogFixture([
      '0000000000000000000000000000000000000000 05efa1d350649e470b436b0fe3dc192b9033795e Scry Test <scry@example.invalid> 1794365630 -0800',
      '05efa1d350649e470b436b0fe3dc192b9033795e 05efa1d350649e470b436b0fe3dc192b9033795e Scry Test <scry@example.invalid> 1794365631 -0800\treset: moving to HEAD'
    ].join('\n'))
    await expect(readWorktreeCreation(dir)).resolves.toEqual({
      creation: {
        commit: '05efa1d350649e470b436b0fe3dc192b9033795e',
        createdAt: new Date(1_794_365_630_000).toISOString(),
        createdMs: 1_794_365_630_000
      }
    })
  })

  it('基线提交解析不出来时记 partial（capture_failed），不冒充可用基线', async () => {
    const root = await gitWorkspace()
    const captureRoot = await mkdtemp(join(tmpdir(), 'scry-capture-'))
    roots.push(captureRoot)
    const snapshot = await finishNewWorktreeBaseline({
      kind: 'baseline',
      requestedRoot: root,
      root,
      baseline: { commit: '0'.repeat(40), at: new Date().toISOString() }
    }, { captureRoot, excludedPaths: [], events: [] })

    // 快照自己的失败状态照实保留；只有基线标记降级成 partial，不再冒充可用。
    expect(snapshot.status).not.toBe('captured')
    expect(snapshot).toMatchObject({
      files: [],
      baselineSource: 'worktree-creation-reflog',
      baselineStatus: 'partial',
      baselineReason: 'capture_failed'
    })
  }, 35_000)

  it('reflog 缺失或第一条不是创建记录时不给基线', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'scry-reflog-'))
    roots.push(missing)
    await expect(readWorktreeCreation(missing)).resolves.toEqual({ problem: 'reflog_missing' })
    const rewritten = await reflogFixture(
      '05efa1d350649e470b436b0fe3dc192b9033795e 05efa1d350649e470b436b0fe3dc192b9033795e Scry Test <scry@example.invalid> 1794365630 -0800\tcherry-pick'
    )
    await expect(readWorktreeCreation(rewritten)).resolves.toEqual({ problem: 'reflog_creation_not_first' })
  })
})
}
