import { describe, it, expect } from 'vitest'
import {
  SESSION_DIFF_PREVIEW_STAGE,
  TURN_DIFF_PREVIEW_STAGE,
  type TraceEvent,
  type TurnDiffSnapshot
} from '@shared/trace'
import type { Turn } from './format'
import {
  displayDiffPath,
  editActionLineCounts,
  resolveTurnDiffReview,
  sessionDiffOf,
  sessionDiffSummary,
  sessionDiffViewOf,
  sessionNetDiffReview,
  sessionNetDiffSummary,
  turnDiffOf,
  turnDiffViewOf
} from './turn-diff'

function snapshot(overrides: Partial<TurnDiffSnapshot> = {}): TurnDiffSnapshot {
  return {
    version: 1,
    status: 'captured',
    files: [],
    repoRoot: '/repo',
    scope: '.',
    beforeAt: '2026-08-10T00:00:00.000Z',
    afterAt: '2026-08-10T00:00:01.000Z',
    captureMs: 12,
    cleanup: 'ok',
    ...overrides
  }
}

function turn(runId: string, userText: string, turnDiff?: TurnDiffSnapshot): Turn {
  const items: TraceEvent[] = [
    { id: `${runId}-text`, ts: '2026-08-10T00:00:00.000Z', runId, kind: 'model', stage: 'text', text: 'ok' }
  ]
  if (turnDiff) {
    items.push({ id: `${runId}-diff`, ts: '2026-08-10T00:00:01.000Z', runId, kind: 'harness', stage: 'turn_diff', turnDiff })
  }
  return { runId, userText, items, done: true }
}

// 一轮里可以同时带「本轮 turn_diff」和「会话 session_diff」；测试要证明会话选择器读的是
// 权威 session_diff（净 diff），而不是逐轮累计。
function sessionTurn(
  runId: string,
  userText: string,
  opts: { turn?: TurnDiffSnapshot; session?: TurnDiffSnapshot } = {}
): Turn {
  const items: TraceEvent[] = [
    { id: `${runId}-text`, ts: '2026-08-10T00:00:00.000Z', runId, kind: 'model', stage: 'text', text: 'ok' }
  ]
  if (opts.turn) {
    items.push({ id: `${runId}-td`, ts: '2026-08-10T00:00:01.000Z', runId, kind: 'harness', stage: 'turn_diff', turnDiff: opts.turn })
  }
  if (opts.session) {
    items.push({ id: `${runId}-sd`, ts: '2026-08-10T00:00:02.000Z', runId, kind: 'harness', stage: 'session_diff', turnDiff: opts.session })
  }
  return { runId, userText, items, done: true }
}

describe('turnDiffOf', () => {
  it('取最后一条 turn_diff，迟到的重复事件覆盖旧快照', () => {
    const late = snapshot({ files: [{ path: '/repo/a.ts', added: 9, deleted: 0 }] })
    const items = turn('r1', '改 a', snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] })).items
    items.push({ id: 'r1-diff2', ts: 'z', runId: 'r1', kind: 'harness', stage: 'turn_diff', turnDiff: late })
    expect(turnDiffOf(items)).toBe(late)
  })

  it('没有 turn_diff 事件时返回 undefined，不编造空快照', () => {
    expect(turnDiffOf(turn('r1', 'hi').items)).toBeUndefined()
  })
})

describe('resolveTurnDiffReview（顶栏 Diff 直接打开的回退）', () => {
  const turns = [
    turn('r1', '第一轮', snapshot({ files: [{ path: '/repo/a.ts', added: 2, deleted: 1 }] })),
    turn('r2', '第二轮', snapshot({ status: 'timeout', reason: 'deadline', files: [] })),
    turn('r3', '第三轮', snapshot({ files: [{ path: '/repo/b.ts', added: 4, deleted: 0 }] })),
    turn('r4', '第四轮')
  ]

  it('直接打开时取最近一个 captured 且有文件的轮次，跳过 timeout 与无 diff 的轮次', () => {
    const review = resolveTurnDiffReview(turns)
    expect(review?.runId).toBe('r3')
    expect(review?.userText).toBe('第三轮')
    expect(review?.initialPath).toBeUndefined()
  })

  it('给了 path 时定位到真正包含该文件的那一轮', () => {
    const review = resolveTurnDiffReview(turns, '/repo/a.ts')
    expect(review?.runId).toBe('r1')
    expect(review?.initialPath).toBe('/repo/a.ts')
  })

  it('显式 runId 只从当前会话重新取快照，不回放旧会话缓存', () => {
    expect(resolveTurnDiffReview(turns, undefined, 'r1')?.runId).toBe('r1')
    expect(resolveTurnDiffReview([turn('n1', '新会话')], undefined, 'r1')).toBeNull()
  })

  it('没有任何可审阅轮次时返回 null，不退回工作区 diff', () => {
    expect(resolveTurnDiffReview([turn('r1', 'hi'), turn('r2', 'hi2', snapshot({ files: [] }))])).toBeNull()
    expect(resolveTurnDiffReview(turns, '/repo/never.ts')).toBeNull()
  })

  it('切会话后 turns 换掉即重新派生，不保留旧会话 snapshot', () => {
    const before = resolveTurnDiffReview(turns)
    const after = resolveTurnDiffReview([turn('n1', '新会话', snapshot({ files: [{ path: '/repo/c.ts', added: 1, deleted: 1 }] }))])
    expect(before?.runId).toBe('r3')
    expect(after?.runId).toBe('n1')
    expect(after?.turnDiff.files[0].path).toBe('/repo/c.ts')
  })
})

describe('sessionDiffSummary（本会话改动 = 各轮累计活动量）', () => {
  it('汇总 unique files，同一文件跨轮 +/− 重复累计', () => {
    const summary = sessionDiffSummary([
      turn('r1', '一', snapshot({
        files: [
          { path: '/repo/a.ts', added: 3, deleted: 1 },
          { path: '/repo/b.ts', added: 2, deleted: 0 }
        ]
      })),
      turn('r2', '二', snapshot({ files: [{ path: '/repo/a.ts', added: 5, deleted: 4 }] }))
    ])
    expect(summary.turnCount).toBe(2)
    expect(summary.added).toBe(10)
    expect(summary.deleted).toBe(5)
    expect(summary.files).toEqual([
      { path: '/repo/a.ts', added: 8, deleted: 5, turns: 2, binary: false },
      { path: '/repo/b.ts', added: 2, deleted: 0, turns: 1, binary: false }
    ])
  })

  it('只统计 captured 轮次，timeout / failed 不贡献假数字', () => {
    const summary = sessionDiffSummary([
      turn('r1', '一', snapshot({ status: 'timeout', reason: 'deadline', files: [] })),
      turn('r2', '二', snapshot({ status: 'failed', reason: 'git_error', files: [] })),
      turn('r3', '三')
    ])
    expect(summary).toEqual({ files: [], added: 0, deleted: 0, turnCount: 0 })
  })

  it('二进制文件保留标记，不把 0/0 说成没改', () => {
    const summary = sessionDiffSummary([
      turn('r1', '一', snapshot({ files: [{ path: '/repo/img.png', added: 0, deleted: 0, binary: true }] }))
    ])
    expect(summary.files).toEqual([{ path: '/repo/img.png', added: 0, deleted: 0, turns: 1, binary: true }])
  })
})

describe('editActionLineCounts（单条 Edit 卡的 action-level 行数）', () => {
  it('按行数统计 old_string / new_string，末尾换行不多算一行', () => {
    expect(editActionLineCounts({ old_string: 'a', new_string: 'b\nc' })).toEqual({ added: 2, deleted: 1 })
    expect(editActionLineCounts({ old_string: 'a\n', new_string: 'b\nc\n' })).toEqual({ added: 2, deleted: 1 })
  })

  it('空串代表纯插入 / 纯删除', () => {
    expect(editActionLineCounts({ old_string: '', new_string: 'x\ny' })).toEqual({ added: 2, deleted: 0 })
    expect(editActionLineCounts({ old_string: 'x\ny', new_string: '' })).toEqual({ added: 0, deleted: 2 })
  })

  it('单个换行是一行空行，不是 0 行', () => {
    expect(editActionLineCounts({ old_string: '\n', new_string: '\n\n' })).toEqual({ added: 2, deleted: 1 })
  })

  it('缺字段只补 0，两个都缺就返回 null（不显示假 +0/−0）', () => {
    expect(editActionLineCounts({ new_string: 'only' })).toEqual({ added: 1, deleted: 0 })
    expect(editActionLineCounts({ file_path: '/repo/a.ts' })).toBeNull()
    expect(editActionLineCounts(undefined)).toBeNull()
    expect(editActionLineCounts('a')).toBeNull()
  })
})

describe('displayDiffPath', () => {
  it('命中 repoRoot 时给相对路径，否则退回 basename', () => {
    expect(displayDiffPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(displayDiffPath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(displayDiffPath('/other/src/a.ts', '/repo')).toBe('a.ts')
    expect(displayDiffPath('/repo/中文/文件.md', '/repo')).toBe('中文/文件.md')
  })
})

describe('sessionDiffOf', () => {
  it('取最后一条 session_diff，迟到的重复事件覆盖旧快照', () => {
    const late = snapshot({ files: [{ path: '/repo/a.ts', added: 3, deleted: 0 }] })
    const items = sessionTurn('r1', '改 a', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }) }).items
    items.push({ id: 'r1-sd2', ts: 'z', runId: 'r1', kind: 'harness', stage: 'session_diff', turnDiff: late })
    expect(sessionDiffOf(items)).toBe(late)
  })

  it('没有 session_diff 事件时返回 undefined，不把 turn_diff 当会话 diff', () => {
    const items = turn('r1', '改 a', snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] })).items
    expect(sessionDiffOf(items)).toBeUndefined()
  })
})

describe('sessionNetDiffReview（右栏会话净 diff 入口）', () => {
  it('取最近一条 session_diff，标 scope=session，且不是逐轮累计', () => {
    // 同一文件跨两轮反复改：逐轮 turn_diff 之和会是 +8/−3，但会话净 diff 快照只有 +3/−0。
    const turns = [
      sessionTurn('r1', '一', {
        turn: snapshot({ files: [{ path: '/repo/a.ts', added: 5, deleted: 3 }] }),
        session: snapshot({ files: [{ path: '/repo/a.ts', added: 5, deleted: 3 }] })
      }),
      sessionTurn('r2', '二', {
        turn: snapshot({ files: [{ path: '/repo/a.ts', added: 3, deleted: 0 }] }),
        session: snapshot({ files: [{ path: '/repo/a.ts', added: 3, deleted: 0 }] })
      })
    ]
    const review = sessionNetDiffReview(turns)
    expect(review?.runId).toBe('r2')
    expect(review?.scope).toBe('session')
    expect(review?.turnDiff.files).toEqual([{ path: '/repo/a.ts', added: 3, deleted: 0 }])
  })

  it('会话净 diff 覆盖不同轮改过的文件全集', () => {
    const turns = [
      sessionTurn('r1', '一', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 2, deleted: 0 }] }) }),
      sessionTurn('r2', '二', {
        session: snapshot({
          files: [
            { path: '/repo/a.ts', added: 2, deleted: 0 },
            { path: '/repo/b.ts', added: 4, deleted: 1 }
          ]
        })
      })
    ]
    expect(sessionNetDiffReview(turns)?.turnDiff.files.map((file) => file.path)).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })

  it('给了 path 时只认最新会话净快照，不复活旧快照里已消失的文件', () => {
    const turns = [
      sessionTurn('r1', '一', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }) }),
      sessionTurn('r2', '二', { session: snapshot({ files: [{ path: '/repo/b.ts', added: 1, deleted: 0 }] }) })
    ]
    expect(sessionNetDiffReview(turns, '/repo/a.ts')).toBeNull()
    expect(sessionNetDiffReview(turns, '/repo/b.ts')?.initialPath).toBe('/repo/b.ts')
    expect(sessionNetDiffReview(turns, '/repo/never.ts')).toBeNull()
  })

  it('最新 session_diff 为 timeout / failed / 空文件时不回退旧快照', () => {
    const turns = [
      sessionTurn('r1', '一', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }) }),
      sessionTurn('r2', '二', { session: snapshot({ status: 'timeout', reason: 'deadline', files: [] }) }),
      sessionTurn('r3', '三', { session: snapshot({ files: [] }) })
    ]
    expect(sessionNetDiffReview(turns)).toBeNull()
  })

  it('最后一轮还没落 session_diff 时回溯到最近一条权威快照，不再整轮空白（修复运行中纵览为空）', () => {
    const turns = [
      sessionTurn('r1', '一', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }) }),
      turn('r2', '长轮次运行中', snapshot({ files: [{ path: '/repo/b.ts', added: 1, deleted: 0 }] }))
    ]
    expect(sessionNetDiffReview(turns)?.runId).toBe('r1')
    expect(sessionNetDiffSummary(turns)?.files).toEqual([{ path: '/repo/a.ts', added: 1, deleted: 0 }])
  })

  it('没有任何 session_diff 时返回 null，不退回 turn_diff', () => {
    const turns = [turn('r1', '一', snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }))]
    expect(sessionNetDiffReview(turns)).toBeNull()
  })
})

describe('sessionNetDiffSummary（结束摘要 = 快照本身的真实净改动）', () => {
  it('直接取快照每文件净增删，不做逐轮累计', () => {
    const turns = [
      sessionTurn('r1', '一', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 5, deleted: 3 }] }) }),
      sessionTurn('r2', '二', {
        session: snapshot({
          files: [
            { path: '/repo/a.ts', added: 3, deleted: 0 },
            { path: '/repo/b.ts', added: 2, deleted: 2 }
          ]
        })
      })
    ]
    expect(sessionNetDiffSummary(turns)).toEqual({
      files: [
        { path: '/repo/a.ts', added: 3, deleted: 0 },
        { path: '/repo/b.ts', added: 2, deleted: 2 }
      ],
      added: 5,
      deleted: 2,
      preview: false
    })
  })

  it('没有可审阅 session_diff 时返回 null，不编空摘要', () => {
    expect(sessionNetDiffSummary([turn('r1', '一', snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }))])).toBeNull()
    expect(sessionNetDiffSummary([sessionTurn('r1', '一', { session: snapshot({ status: 'failed', reason: 'git_error', files: [] }) })])).toBeNull()
  })
})

function previewTurn(
  runId: string,
  userText: string,
  opts: { turnPreview?: TurnDiffSnapshot; sessionPreview?: TurnDiffSnapshot; turnFinal?: TurnDiffSnapshot; sessionFinal?: TurnDiffSnapshot } = {}
): Turn {
  const items: TraceEvent[] = [
    { id: `${runId}-text`, ts: '2026-08-10T00:00:00.000Z', runId, kind: 'model', stage: 'text', text: 'ok' }
  ]
  if (opts.turnPreview) items.push({ id: `${runId}-tp`, ts: '2026-08-10T00:00:01.000Z', runId, kind: 'harness', stage: TURN_DIFF_PREVIEW_STAGE, turnDiff: opts.turnPreview })
  if (opts.sessionPreview) items.push({ id: `${runId}-sp`, ts: '2026-08-10T00:00:01.500Z', runId, kind: 'harness', stage: SESSION_DIFF_PREVIEW_STAGE, turnDiff: opts.sessionPreview })
  if (opts.turnFinal) items.push({ id: `${runId}-tf`, ts: '2026-08-10T00:00:02.000Z', runId, kind: 'harness', stage: 'turn_diff', turnDiff: opts.turnFinal })
  if (opts.sessionFinal) items.push({ id: `${runId}-sf`, ts: '2026-08-10T00:00:02.500Z', runId, kind: 'harness', stage: 'session_diff', turnDiff: opts.sessionFinal })
  return { runId, userText, items, done: false }
}

describe('运行中预览优先级：终态永远压过预览，不倒退', () => {
  it('turnDiffViewOf：只有预览时用预览并标 preview=true', () => {
    const view = turnDiffViewOf(previewTurn('r1', '运行中', { turnPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 3, deleted: 0 }] }) }).items)
    expect(view?.preview).toBe(true)
    expect(view?.turnDiff.files).toEqual([{ path: '/repo/a.ts', added: 3, deleted: 0 }])
  })

  it('turnDiffViewOf：终态在场时用终态并标 preview=false（哪怕预览数字更大）', () => {
    const view = turnDiffViewOf(previewTurn('r1', '完成', {
      turnPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 9, deleted: 9 }] }),
      turnFinal: snapshot({ files: [{ path: '/repo/a.ts', added: 3, deleted: 0 }] })
    }).items)
    expect(view?.preview).toBe(false)
    expect(view?.turnDiff.files).toEqual([{ path: '/repo/a.ts', added: 3, deleted: 0 }])
  })

  it('sessionDiffViewOf：同样终态优先、预览兜底', () => {
    expect(sessionDiffViewOf(previewTurn('r1', '运行中', { sessionPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }) }).items)?.preview).toBe(true)
    expect(sessionDiffViewOf(previewTurn('r1', '完成', {
      sessionPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 9, deleted: 0 }] }),
      sessionFinal: snapshot({ files: [{ path: '/repo/a.ts', added: 2, deleted: 0 }] })
    }).items)?.preview).toBe(false)
  })

  it('turnDiffOf / sessionDiffOf 只认终态：累计活动量不会把临时预览算进去', () => {
    const items = previewTurn('r1', '运行中', {
      turnPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 5, deleted: 0 }] }),
      sessionPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 5, deleted: 0 }] })
    }).items
    expect(turnDiffOf(items)).toBeUndefined()
    expect(sessionDiffOf(items)).toBeUndefined()
    expect(sessionDiffSummary([{ runId: 'r1', userText: '运行中', items, done: false }]).turnCount).toBe(0)
  })

  it('sessionNetDiffSummary 透传 preview 标记与 baseline 来源', () => {
    const preview = sessionNetDiffSummary([
      previewTurn('r1', '运行中', { sessionPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }], baseline: 'resumed' }) })
    ])
    expect(preview?.preview).toBe(true)
    expect(preview?.baseline).toBe('resumed')
    const settled = sessionNetDiffSummary([
      sessionTurn('r1', '完成', { session: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }], baseline: 'session_start' }) })
    ])
    expect(settled?.preview).toBe(false)
    expect(settled?.baseline).toBe('session_start')
  })

  it('sessionNetDiffReview 在只有预览时也能打开，并带 preview 标记', () => {
    const review = sessionNetDiffReview([
      previewTurn('r1', '运行中', { sessionPreview: snapshot({ files: [{ path: '/repo/a.ts', added: 1, deleted: 0 }] }) })
    ])
    expect(review?.scope).toBe('session')
    expect(review?.preview).toBe(true)
  })
})
