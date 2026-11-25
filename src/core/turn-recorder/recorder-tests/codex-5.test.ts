import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { USAGE_BASELINE_MISSING_REASON } from '../../../shared/turn-record'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, payload } from './fixture.test'

/**
 * Codex reports session-cumulative usage, so a turn's usage is a difference. These cases pin how the
 * parser obtains the baseline before the first frame it can see: a window frame, a proof derived from
 * the frame's own `last_token_usage`, or nothing at all (unknown, never the session total).
 */
export function registerCodexUsageBaselineSuite(): void {
  const row = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
  const counters = (input: number, output: number, cache: number) => ({
    input_tokens: input,
    output_tokens: output,
    cached_input_tokens: cache,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0
  })
  const frame = (
    timestamp: string,
    total: { input: number; output: number; cache: number },
    last?: { input: number; output: number; cache: number }
  ) => row(timestamp, 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: counters(total.input, total.output, total.cache),
      ...(last ? { last_token_usage: counters(last.input, last.output, last.cache) } : {}),
      model_context_window: 400_000
    }
  })
  const start = (timestamp: string, turnId: string) => row(timestamp, 'event_msg', { type: 'task_started', turn_id: turnId })
  const done = (timestamp: string, turnId: string) => row(timestamp, 'event_msg', { type: 'task_complete', turn_id: turnId })
  const write = async (root: string, name: string, lines: unknown[]): Promise<string> => {
    const path = join(root, name)
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    return path
  }
  const record = async (
    root: string,
    rollout: string,
    sessionId: string,
    turnId: string,
    bounds: { started: string; completed: string }
  ): Promise<void> => {
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload(sessionId, { prompt: turnId, turn_id: turnId, rollout_path: rollout, timestamp: bounds.started })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload(sessionId, { turn_id: turnId, rollout_path: rollout, timestamp: bounds.completed })
    })
  }

  it('续写文件首轮没有窗口基线时，用首帧的累计减最近一次证明基线，不把会话累计写成本轮', async () => {
    const root = await workspace()
    const rollout = await write(root, 'resumed-rollout.jsonl', [
      row('2026-07-19T12:00:00.000Z', 'session_meta', { id: 'resumed-session', cwd: root }),
      start('2026-07-19T12:00:00.000Z', 't1'),
      frame('2026-07-19T12:00:00.100Z', { input: 2_500_000_000, output: 8_000, cache: 2_450_000_000 }, { input: 200_000, output: 300, cache: 150_000 }),
      done('2026-07-19T12:00:01.000Z', 't1'),
      start('2026-07-19T12:00:02.000Z', 't2'),
      frame('2026-07-19T12:00:02.100Z', { input: 2_500_050_000, output: 8_100, cache: 2_450_020_000 }, { input: 50_000, output: 100, cache: 20_000 }),
      done('2026-07-19T12:00:03.000Z', 't2')
    ])
    await record(root, rollout, 'c1', 't1', { started: '2026-07-19T12:00:00.000Z', completed: '2026-07-19T12:00:01.000Z' })
    await record(root, rollout, 'c1', 't2', { started: '2026-07-19T12:00:02.000Z', completed: '2026-07-19T12:00:03.000Z' })

    const records = await listRecords(join(root, '.scry'))
    expect(records.map((entry) => entry.usage.status)).toEqual(['available', 'available'])
    expect(records[0].usage.value).toEqual(expect.objectContaining({
      inputTokens: 200_000,
      outputTokens: 300,
      cacheReadTokens: 150_000
    }))
    expect(records[1].usage.value).toEqual(expect.objectContaining({ inputTokens: 50_000, outputTokens: 100 }))
    // 逐轮用量加回推导出的基线，必须等于文件末帧的累计：没有把会话总量塞进任何一轮。
    const baseline = 2_500_000_000 - 200_000
    expect((records[0].usage.value?.inputTokens ?? 0) + (records[1].usage.value?.inputTokens ?? 0) + baseline)
      .toBe(2_500_050_000)
  })

  it('首帧没有最近一次用量时无法证明基线：本轮用量标未知并写原因码，后续轮仍然精确', async () => {
    const root = await workspace()
    const rollout = await write(root, 'unprovable-rollout.jsonl', [
      row('2026-07-19T12:00:00.000Z', 'session_meta', { id: 'unprovable-session', cwd: root }),
      start('2026-07-19T12:00:00.000Z', 't1'),
      frame('2026-07-19T12:00:00.100Z', { input: 550_229_534, output: 669_480, cache: 541_146_752 }),
      done('2026-07-19T12:00:01.000Z', 't1'),
      start('2026-07-19T12:00:02.000Z', 't2'),
      frame('2026-07-19T12:00:02.100Z', { input: 550_229_634, output: 669_580, cache: 541_146_752 }),
      done('2026-07-19T12:00:03.000Z', 't2')
    ])
    await record(root, rollout, 'c1', 't1', { started: '2026-07-19T12:00:00.000Z', completed: '2026-07-19T12:00:01.000Z' })
    await record(root, rollout, 'c1', 't2', { started: '2026-07-19T12:00:02.000Z', completed: '2026-07-19T12:00:03.000Z' })

    const records = await listRecords(join(root, '.scry'))
    expect(records[0].usage.status).toBe('unavailable')
    expect(records[0].usage.quality).toBe('unavailable')
    expect(records[0].usage.value).toBeUndefined()
    // No code is written yet: servers and older readers only accept the diff codes, and one unknown
    // code would reject the whole record. The sentence is the contract until they catch up.
    expect(records[0].usage.omissionCodes).toBeUndefined()
    expect(records[0].usage.omissionReason).toBe(USAGE_BASELINE_MISSING_REASON)
    expect(records[1].usage.status).toBe('available')
    expect(records[1].usage.value).toEqual(expect.objectContaining({ inputTokens: 100, outputTokens: 100 }))
  })

  it('真正从 0 开始的新会话首帧累计等于最近一次，照常按本轮算，不误标未知', async () => {
    const root = await workspace()
    const rollout = await write(root, 'fresh-rollout.jsonl', [
      row('2026-07-19T12:00:00.000Z', 'session_meta', { id: 'fresh-session', cwd: root }),
      start('2026-07-19T12:00:00.000Z', 't1'),
      frame('2026-07-19T12:00:00.100Z', { input: 200_000, output: 900, cache: 0 }, { input: 200_000, output: 900, cache: 0 }),
      done('2026-07-19T12:00:01.000Z', 't1')
    ])
    await record(root, rollout, 'c1', 't1', { started: '2026-07-19T12:00:00.000Z', completed: '2026-07-19T12:00:01.000Z' })

    const [entry] = await listRecords(join(root, '.scry'))
    expect(entry.usage.status).toBe('available')
    expect(entry.usage.value).toEqual(expect.objectContaining({ inputTokens: 200_000, outputTokens: 900 }))
    expect(entry.usage.omissionCodes).toBeUndefined()
  })

  it('窗口里仍有前序累计帧时用那一帧做基线，不走首帧推导', async () => {
    const root = await workspace()
    const rollout = await write(root, 'windowed-rollout.jsonl', [
      row('2026-07-19T12:00:00.000Z', 'session_meta', { id: 'windowed-session', cwd: root }),
      start('2026-07-19T12:00:00.000Z', 't1'),
      frame('2026-07-19T12:00:00.100Z', { input: 700_000, output: 1_000, cache: 600_000 }, { input: 700_000, output: 1_000, cache: 600_000 }),
      done('2026-07-19T12:00:01.000Z', 't1'),
      start('2026-07-19T12:00:02.000Z', 't2'),
      // 首帧的 last 与真实差值不一致也要被忽略：证明过的窗口基线优先。
      frame('2026-07-19T12:00:02.100Z', { input: 900_000, output: 1_200, cache: 800_000 }, { input: 120_000, output: 200, cache: 100_000 }),
      done('2026-07-19T12:00:03.000Z', 't2')
    ])
    await record(root, rollout, 'c1', 't1', { started: '2026-07-19T12:00:00.000Z', completed: '2026-07-19T12:00:01.000Z' })
    await record(root, rollout, 'c1', 't2', { started: '2026-07-19T12:00:02.000Z', completed: '2026-07-19T12:00:03.000Z' })

    const records = await listRecords(join(root, '.scry'))
    expect(records[1].usage.status).toBe('available')
    expect(records[1].usage.value).toEqual(expect.objectContaining({ inputTokens: 200_000, outputTokens: 200, cacheReadTokens: 200_000 }))
  })

  it('窗口外才有的前序帧同样用首帧推导基线：差值与末累计对得上，不存整会话', async () => {
    const root = await workspace()
    const padding = 'x'.repeat(300 * 1024)
    const rollout = await write(root, 'outside-window-rollout.jsonl', [
      row('2026-07-19T12:00:00.000Z', 'session_meta', { id: 'outside-session', cwd: root }),
      start('2026-07-19T12:00:00.000Z', 't1'),
      frame('2026-07-19T12:00:00.100Z', { input: 400_000, output: 1_000, cache: 300_000 }, { input: 400_000, output: 1_000, cache: 300_000 }),
      done('2026-07-19T12:00:01.000Z', 't1'),
      // 把上一帧推到 256 KiB 窗口之外，窗口扫描找不到基线。
      row('2026-07-19T12:00:01.500Z', 'opaque_padding', { blob: padding }),
      start('2026-07-19T12:00:02.000Z', 't2'),
      frame('2026-07-19T12:00:02.100Z', { input: 780_000, output: 1_400, cache: 600_000 }, { input: 380_000, output: 400, cache: 300_000 }),
      done('2026-07-19T12:00:03.000Z', 't2')
    ])
    await record(root, rollout, 'c1', 't1', { started: '2026-07-19T12:00:00.000Z', completed: '2026-07-19T12:00:01.000Z' })
    await record(root, rollout, 'c1', 't2', { started: '2026-07-19T12:00:02.000Z', completed: '2026-07-19T12:00:03.000Z' })

    const records = await listRecords(join(root, '.scry'))
    expect(records[1].usage.status).toBe('available')
    expect(records[1].usage.value).toEqual(expect.objectContaining({ inputTokens: 380_000, outputTokens: 400, cacheReadTokens: 300_000 }))
  })

  it('窗口外且首帧缺最近一次用量：标未知，不退回累计值', async () => {
    const root = await workspace()
    const padding = 'x'.repeat(300 * 1024)
    const rollout = await write(root, 'outside-window-no-last.jsonl', [
      row('2026-07-19T12:00:00.000Z', 'session_meta', { id: 'outside-no-last', cwd: root }),
      start('2026-07-19T12:00:00.000Z', 't1'),
      frame('2026-07-19T12:00:00.100Z', { input: 400_000, output: 1_000, cache: 300_000 }, { input: 400_000, output: 1_000, cache: 300_000 }),
      done('2026-07-19T12:00:01.000Z', 't1'),
      row('2026-07-19T12:00:01.500Z', 'opaque_padding', { blob: padding }),
      start('2026-07-19T12:00:02.000Z', 't2'),
      frame('2026-07-19T12:00:02.100Z', { input: 780_000, output: 1_400, cache: 600_000 }),
      done('2026-07-19T12:00:03.000Z', 't2')
    ])
    await record(root, rollout, 'c1', 't1', { started: '2026-07-19T12:00:00.000Z', completed: '2026-07-19T12:00:01.000Z' })
    await record(root, rollout, 'c1', 't2', { started: '2026-07-19T12:00:02.000Z', completed: '2026-07-19T12:00:03.000Z' })

    const records = await listRecords(join(root, '.scry'))
    expect(records[1].usage.status).toBe('unavailable')
    expect(records[1].usage.quality).toBe('unavailable')
    expect(records[1].usage.value).toBeUndefined()
    expect(records[1].usage.omissionCodes).toBeUndefined()
    expect(records[1].usage.omissionReason).toBe(USAGE_BASELINE_MISSING_REASON)
  })
}
