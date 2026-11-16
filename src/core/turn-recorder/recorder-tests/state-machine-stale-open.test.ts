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
    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('interrupted')
    expect(record.termination?.omissionReason).toContain('an operator asserted the session is gone')
  }, 40_000)

  it('没有 transcript：静默不是中断证据，只有显式过期才收尾', async () => {
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

    await expect(recoverRecorder(root, process.env, undefined, undefined, { expireOpen: true }))
      .resolves.toMatchObject({ recovered: 1, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('interrupted')
    expect(record.user.value?.text).toContain('summarize the repository')
    expect(JSON.parse(await readFile(join(sessionDir, 'open.json'), 'utf8').catch(() => 'null'))).toBeNull()
  }, 40_000)
}
