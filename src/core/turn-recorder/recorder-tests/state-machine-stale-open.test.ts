import { readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, recoverRecorder } from '../recorder'
import { listRecords, readHealth, safeKey } from '../store'
import { recorderOpenTurns } from '../runtime-state'
import { workspace, payload } from './fixture.test'

const session = 'qoder-stale-open'
const MINUTE = 60_000

/**
 * An open turn no terminal event will ever reach.
 *
 * Qoder, Claude and OpenCode never write a terminal status into their transcripts — only Codex and
 * Pi do — so recovery had no way to close a turn after a lost Stop, and no window expired an `open`
 * turn. The turn stayed open forever, and health could not see it: `openTurnsPending` counted only
 * `closing`/managed turns.
 *
 * The rules under test: a finished reply plus silence may close the turn on its own transcript; a
 * turn that might still be working may not; and the difference has to be visible in health either
 * way.
 */
async function qoderTurn(root: string, transcript: string): Promise<void> {
  await handleRecorderHook({
    provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
    payload: payload(session, {
      prompt: 'summarize the repository', transcript_path: transcript, request_set_id: 'request-1',
      timestamp: new Date(Date.now() - 40 * MINUTE).toISOString()
    })
  })
}

/**
 * Move everything this turn wrote into the past. The quiet window is measured from the files the
 * turn produced, so a test that only backdates `open.json` would not describe a silent session.
 */
async function backdateTurn(root: string, session: string, transcript: string, minutes: number): Promise<void> {
  const at = new Date(Date.now() - minutes * MINUTE)
  await utimes(transcript, at, at)
  const sessionDir = join(root, '.scry', 'runtime', 'qoder', safeKey(session))
  await utimes(join(sessionDir, 'open.json'), at, at)
  const turns = await readdir(join(sessionDir, 'turns')).catch(() => [] as string[])
  for (const turn of turns) {
    const eventsDir = join(sessionDir, 'turns', turn, 'events')
    for (const name of await readdir(eventsDir).catch(() => [] as string[])) {
      await utimes(join(eventsDir, name), at, at)
    }
  }
}

const DEAD_PID = 999_999

/**
 * Host evidence is written at start time, so a test that wants "the host died" must say so: the
 * process running the test is alive and would otherwise veto every expiry.
 */
async function recordHost(root: string, session: string, host: Array<{ pid: number; token?: string }> | undefined): Promise<void> {
  const path = join(root, '.scry', 'runtime', 'qoder', safeKey(session), 'open.json')
  const open = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (host) open.host = host
  else delete open.host
  await writeFile(path, JSON.stringify(open))
}

const replyRow = (stopReason: string) => JSON.stringify({
  type: 'assistant', timestamp: new Date(Date.now() - 38 * MINUTE).toISOString(), promptId: 'prompt-1',
  message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text: 'Here is the summary.' }] }
})

const userRow = (text: string) => JSON.stringify({
  type: 'user', timestamp: new Date(Date.now() - 39 * MINUTE).toISOString(), promptId: 'prompt-1',
  requestSetId: 'request-1', message: { role: 'user', content: text }
})

export function registerStaleOpenTurnSuite(): void {
  it('回复已结束、Stop 丢失且长时间静默：按 transcript 收尾并标明没有终态事件', async () => {
    const root = await workspace()
    const transcript = join(root, 'stale-finished.jsonl')
    await writeFile(transcript, `${[userRow('summarize the repository'), replyRow('end_turn')].join('\n')}\n`)
    await qoderTurn(root, transcript)
    await backdateTurn(root, session, transcript, 35)

    // 时间已经过窗、回复也结束：恢复是安全的，但结束时间只能是最新一行活动（下界）。
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('completed')
    expect(record.assistant.value?.text).toContain('Here is the summary.')
    expect(record.termination).toMatchObject({
      quality: 'estimated',
      value: { reason: 'expired', completedAtSource: 'last_observed_activity' }
    })
    expect(record.termination?.omissionReason).toContain('stop_reason=end_turn')
    expect(record.termination?.omissionReason).toContain('no terminal event was observed')
    // 这条恢复要留下回执：健康计数加一，open 状态消失。
    expect((await readHealth(join(root, '.scry'))).recoveredRecords).toBe(1)
    await expect(recorderOpenTurns(join(root, '.scry'))).resolves.toEqual([])
  }, 40_000)

  it('会话仍在增长：不收尾，但 health 能看到它', async () => {
    const root = await workspace()
    const transcript = join(root, 'still-running.jsonl')
    await writeFile(transcript, `${[userRow('summarize the repository'), replyRow('tool_use')].join('\n')}\n`)
    await qoderTurn(root, transcript)
    // 刚刚写过东西：正在思考或等外部结果，恢复不能替它决定结束。
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    const health = await readHealth(join(root, '.scry'))
    expect(health).toMatchObject({ openTurns: 1, staleOpenTurns: 0 })
    expect(health.pendingCount).toBe(0)
    const [turn] = await recorderOpenTurns(join(root, '.scry'))
    expect(turn).toMatchObject({ sessionId: session, status: 'open', growing: true, stale: false })
    expect(turn.lastEventAt).toBeTruthy()
  }, 40_000)

  it('等待工具结果且长时间静默：默认不收尾，health 标 stale，操作者显式过期后才收', async () => {
    const root = await workspace()
    const transcript = join(root, 'stale-waiting.jsonl')
    await writeFile(transcript, `${[userRow('summarize the repository'), replyRow('tool_use')].join('\n')}\n`)
    await qoderTurn(root, transcript)
    await backdateTurn(root, session, transcript, 35)

    // `tool_use` 表示模型还在等结果，没有完成证据：宁可继续 open。
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    const health = await readHealth(join(root, '.scry'))
    expect(health).toMatchObject({ openTurns: 1, staleOpenTurns: 1 })
    const [turn] = await recorderOpenTurns(join(root, '.scry'))
    expect(turn).toMatchObject({ stale: true, growing: false })
    expect(turn.quietMs).toBeGreaterThan(30 * MINUTE)
    expect(turn.lastEventAt).toBeTruthy()

    // 操作者知道进程已经没了：这时才允许按 interrupted 收尾，并写明来源。
    await recordHost(root, session, [{ pid: DEAD_PID }])
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('interrupted')
    expect(record.termination?.quality).toBe('estimated')
    expect(record.termination?.value?.reason).toBe('expired')
    expect(record.termination?.omissionReason).toContain(`every process that hosted this turn at start is gone (recorded pids ${DEAD_PID})`)
    // 恢复收尾带着不确定：正文证据标 partial 并写明原因，不冒充逐次观测到的结束。
    expect(record.tools.status).toBe('partial')
    expect(record.tools.omissionReason).toContain('force-closed')
  }, 40_000)

  it('没有 transcript 时只剩静默一条证据；没有进程证据就不收尾', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
      payload: payload(session, {
        prompt: 'summarize the repository', request_set_id: 'request-1',
        timestamp: new Date(Date.now() - 40 * MINUTE).toISOString()
      })
    })
    const sessionDir = join(root, '.scry', 'runtime', 'qoder', safeKey(session))
    const old = new Date(Date.now() - 40 * MINUTE)
    await utimes(join(sessionDir, 'open.json'), old, old)
    for (const turn of await readdir(join(sessionDir, 'turns')).catch(() => [] as string[])) {
      const eventsDir = join(sessionDir, 'turns', turn, 'events')
      for (const name of await readdir(eventsDir).catch(() => [] as string[])) await utimes(join(eventsDir, name), old, old)
    }

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ openTurns: 1, staleOpenTurns: 1 })

    // 没有进程证据时不能假设进程已经退出：静默 + 没有 host 都不足以收尾，轮次继续 open。
    await recordHost(root, session, undefined)
    await expect(recorderOpenTurns(join(root, '.scry'))).resolves.toMatchObject([{ host: 'unknown', stale: true }])
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ openTurns: 1, staleOpenTurns: 1 })

    // 只有确认进程链全部不存在之后才收尾。
    await recordHost(root, session, [{ pid: DEAD_PID }])
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toMatchObject({ recovered: 1, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('interrupted')
    expect(record.termination?.omissionReason).toContain('every process that hosted this turn at start is gone')
    expect(record.user.value?.text).toContain('summarize the repository')
    expect(JSON.parse(await readFile(join(sessionDir, 'open.json'), 'utf8').catch(() => 'null'))).toBeNull()
  }, 40_000)

  it('宿主进程还活着：即使长时间静默也不自动收尾，只在 health 里标 stale', async () => {
    const root = await workspace()
    const transcript = join(root, 'host-alive.jsonl')
    await writeFile(transcript, `${[userRow('summarize the repository'), replyRow('tool_use')].join('\n')}\n`)
    await qoderTurn(root, transcript)
    await backdateTurn(root, session, transcript, 35)
    // 进程确实还在跑：自动调用（每 15 分钟一次的 recover --expire-open）不能替它决定结束。
    await recordHost(root, session, [{ pid: process.pid }])

    const [turn] = await recorderOpenTurns(join(root, '.scry'))
    expect(turn).toMatchObject({ stale: true, host: 'running' })
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ openTurns: 1, staleOpenTurns: 1 })

    // 进程真的退出后（pid 不再存在），同一开关才收尾。
    await recordHost(root, session, [{ pid: DEAD_PID }])
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record).toMatchObject({ status: 'interrupted' })
    expect(record.termination?.value?.reason).toBe('expired')
  }, 40_000)

  it('同一轮被收尾后重复执行 --expire-open 不产生第二条记录', async () => {
    const root = await workspace()
    const transcript = join(root, 'idempotent.jsonl')
    await writeFile(transcript, `${[userRow('summarize the repository'), replyRow('tool_use')].join('\n')}\n`)
    await qoderTurn(root, transcript)
    await backdateTurn(root, session, transcript, 35)
    await recordHost(root, session, [{ pid: DEAD_PID }])

    const first = await recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true })
    expect(first).toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    const second = await recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true })
    const third = await recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true })
    expect(second).toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(third).toEqual({ recovered: 0, pending: 0, expired: 0 })
    // 幂等：仍然只有一条记录，sequence 与收尾时间都没有变。
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ recordId: record?.recordId, sequence: record?.sequence, completedAt: record?.completedAt })
    await expect(recorderOpenTurns(join(root, '.scry'))).resolves.toEqual([])
  }, 40_000)

  it('按会话收尾：一个判断不了的轮次不该挡住同工作区里能收尾的轮次', async () => {
    const root = await workspace()
    const unknownSession = 'qoder-stale-unknown'
    const goneSession = 'qoder-stale-gone'
    const quiet = async (sessionId: string, name: string) => {
      const transcript = join(root, name)
      await writeFile(transcript, `${[userRow('summarize the repository'), replyRow('tool_use')].join('\n')}\n`)
      await handleRecorderHook({
        provider: 'qoder', event: 'UserPromptSubmit', workspace: root,
        payload: payload(sessionId, {
          prompt: 'summarize the repository', transcript_path: transcript, request_set_id: `request-${name}`,
          timestamp: new Date(Date.now() - 40 * MINUTE).toISOString()
        })
      })
      await backdateTurn(root, sessionId, transcript, 35)
      return transcript
    }
    await quiet(unknownSession, 'unknown-host.jsonl')
    await quiet(goneSession, 'gone-host.jsonl')
    // 一个轮次没有进程证据（判断不了），另一个的宿主已经确定不存在。
    await recordHost(root, goneSession, [{ pid: DEAD_PID }])

    const open = await recorderOpenTurns(join(root, '.scry'))
    expect(open.map((turn) => [turn.sessionId, turn.host]).sort()).toEqual([
      [goneSession, 'gone'],
      [unknownSession, 'unknown']
    ])

    // 只指定"判断不了"的那个会话：没有进程证据，一律不动。
    await expect(recoverRecorder(root, process.env, undefined, undefined, {
      expireOpen: true, expireSessions: [unknownSession]
    })).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])

    // 只对确定已结束的会话收尾，另一个保持 open。
    await expect(recoverRecorder(root, process.env, undefined, undefined, {
      expireOpen: true, expireSessions: [goneSession]
    })).resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0]?.sessionId).toBe(goneSession)
    const remaining = await recorderOpenTurns(join(root, '.scry'))
    expect(remaining.map((turn) => [turn.sessionId, turn.host])).toEqual([[unknownSession, 'unknown']])

    // 幂等：同一范围再跑一次不会重复收尾；不带 --session 的整工作区调用也不能收掉剩下的轮次。
    await expect(recoverRecorder(root, process.env, undefined, undefined, {
      expireOpen: true, expireSessions: [goneSession]
    })).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(1)
  }, 60_000)
}
