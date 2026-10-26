import { describe, expect, it } from 'vitest'
import { SESSION_DIFF_PREVIEW_STAGE, SESSION_DIFF_STAGE, TURN_DIFF_STAGE } from '../shared/turn-diff'
import type { TraceEvent } from '../shared/trace'
import { projectHistoryPageSnapshots, selectArchivePageTurns } from './session-history-page-projection'
import type { SessionHistoryPage } from './session-history'
import type { TraceArchive } from './transcript-archive'

const diffEvent = (runId: string, stage: string, files: number): TraceEvent => ({
  id: `${runId}-${stage}`,
  ts: '2026-01-01T00:00:00.000Z',
  runId,
  kind: 'harness',
  stage,
  turnDiff: {
    version: 1,
    status: 'captured',
    files: Array.from({ length: files }, (_, index) => ({
      path: `/repo/file-${index}.ts`,
      added: index + 1,
      deleted: index,
      patch: `@@ -${index} +${index} @@\n${'x'.repeat(64)}\n`
    })),
    beforeAt: '2026-01-01T00:00:00.000Z',
    afterAt: '2026-01-01T00:00:01.000Z',
    captureMs: 5,
    cleanup: 'ok'
  }
})

const pageOf = (itemsPerTurn: TraceEvent[][]): SessionHistoryPage => ({
  turns: itemsPerTurn.map((items, index) => ({
    runId: `run-${index}`,
    userText: `request ${index}`,
    items,
    done: true
  })),
  offset: 0,
  totalTurns: itemsPerTurn.length,
  hasOlder: false,
  completeness: 'complete'
})

describe('reuse the archive page already parsed for native reconciliation', () => {
  it('只把未覆盖的 runId 交回读盘，覆盖的轮次直接复用', () => {
    const archive: TraceArchive = {
      version: 3,
      cwd: '/repo',
      sessionId: 'pi-session',
      providerId: 'pi',
      turns: ['run-a', 'run-b'].map((runId) => ({ runId, userText: runId, items: [], done: true, ts: 1 }))
    }
    const covered = selectArchivePageTurns(archive, ['run-a', 'run-c', 'run-b'])
    expect(covered.turns.map((turn) => turn.runId)).toEqual(['run-a', 'run-b'])
    expect(covered.missingRunIds).toEqual(['run-c'])
    // 没有可复用页（例如 Profile 限定的页）时必须全部回退读盘，不能静默缺轮。
    expect(selectArchivePageTurns(null, ['run-a'])).toEqual({ turns: [], missingRunIds: ['run-a'] })
    expect(selectArchivePageTurns(archive, []).turns).toEqual([])
  })
})

describe('history page keeps cumulative session snapshots only where the renderer reads them', () => {
  it('只保留页面内最新一条累积会话快照，其余轮次的证据不动', () => {
    const page = pageOf([
      [diffEvent('run-0', SESSION_DIFF_STAGE, 3), diffEvent('run-0', TURN_DIFF_STAGE, 1)],
      [diffEvent('run-1', SESSION_DIFF_STAGE, 3), diffEvent('run-1', TURN_DIFF_STAGE, 2)],
      [diffEvent('run-2', TURN_DIFF_STAGE, 1)]
    ])
    const projected = projectHistoryPageSnapshots(page)
    // run-2 没有累积快照，run-1 的那条就是页面内最新的一条。
    expect(projected.turns.map((turn) => turn.items.map((event) => event.stage))).toEqual([
      [TURN_DIFF_STAGE],
      [SESSION_DIFF_STAGE, TURN_DIFF_STAGE],
      [TURN_DIFF_STAGE]
    ])
    // 负对照：未投影的页仍带着每一轮的累积快照，也就是旧行为跨 IPC 传输的体积。
    expect(page.turns.flatMap((turn) => turn.items).filter((event) => event.stage === SESSION_DIFF_STAGE)).toHaveLength(2)
    // 输入页不被修改：main 侧 sessionHistoryCache 仍保留全部快照。
    expect(page.turns[0].items.map((event) => event.stage)).toEqual([SESSION_DIFF_STAGE, TURN_DIFF_STAGE])
  })

  it('最新一条累积快照即使是空快照也保留，不复活更早的净 diff', () => {
    const empty = { id: 'empty', ts: '2026-01-01T00:00:00.000Z', runId: 'run-1', kind: 'harness', stage: SESSION_DIFF_STAGE } as TraceEvent
    const page = pageOf([[diffEvent('run-0', SESSION_DIFF_STAGE, 4)], [empty]])
    const projected = projectHistoryPageSnapshots(page)
    expect(projected.turns[1].items.some((event) => event.stage === SESSION_DIFF_STAGE)).toBe(true)
    expect(projected.turns[0].items.some((event) => event.stage === SESSION_DIFF_STAGE)).toBe(false)
  })

  it('终态快照与运行中 preview 快照各自保留最新一条', () => {
    const page = pageOf([
      [diffEvent('run-0', SESSION_DIFF_STAGE, 2), diffEvent('run-0', SESSION_DIFF_PREVIEW_STAGE, 2)],
      [diffEvent('run-1', SESSION_DIFF_STAGE, 3), diffEvent('run-1', SESSION_DIFF_PREVIEW_STAGE, 3)]
    ])
    const projected = projectHistoryPageSnapshots(page)
    expect(projected.turns.flatMap((turn) => turn.items.map((event) => `${event.runId}:${event.stage}`))).toEqual([
      'run-1:session_diff',
      'run-1:session_diff_preview'
    ])
  })

  it('没有累积快照的页保持原样（不添加、不重排）', () => {
    const page = pageOf([[diffEvent('run-0', TURN_DIFF_STAGE, 1)], [diffEvent('run-1', TURN_DIFF_STAGE, 2)]])
    const projected = projectHistoryPageSnapshots(page)
    expect(projected.turns.map((turn) => turn.items)).toEqual(page.turns.map((turn) => turn.items))
    expect(projected).toMatchObject({ offset: 0, totalTurns: 2, hasOlder: false, completeness: 'complete' })
  })
})
