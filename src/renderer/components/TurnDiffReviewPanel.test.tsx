// Diff Review 头部文案的诚实性回归：会话净 diff 的基线可能是「会话首轮前」，
// 也可能是恢复该会话时当场重锚的（baseline='resumed'）。后者只覆盖「自恢复以来」，
// 面板绝不能继续写「第一轮前基线 → 当前」。renderToStaticMarkup 纯 node 跑，无需 DOM。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TurnDiffBaselineOrigin, TurnDiffSnapshot } from '@shared/trace'
import type { TurnDiffReview } from '../turn-diff'
import { TurnDiffReviewPanel } from './TurnDiffReviewPanel'

function snapshot(baseline?: TurnDiffBaselineOrigin): TurnDiffSnapshot {
  return {
    version: 1,
    status: 'captured',
    files: [{ path: '/repo/src/a.ts', added: 3, deleted: 1, patch: '@@ -1 +1 @@\n-old\n+new\n' }],
    beforeAt: '2026-08-14T00:00:00.000Z',
    afterAt: '2026-08-14T00:00:01.000Z',
    captureMs: 12,
    cleanup: 'ok',
    repoRoot: '/repo',
    ...(baseline ? { baseline } : {})
  }
}

function markup(review: Partial<TurnDiffReview> & { turnDiff: TurnDiffSnapshot }): string {
  return renderToStaticMarkup(
    <TurnDiffReviewPanel
      review={{ runId: 'run-1', userText: '改一下 a.ts', ...review }}
      onClose={() => {}}
    />
  )
}

describe('TurnDiffReviewPanel 会话基线文案', () => {
  it('baseline=resumed 终态：说「自恢复以来」，不说「第一轮前基线」', () => {
    const html = markup({ turnDiff: snapshot('resumed'), scope: 'session' })
    expect(html).toContain('本会话净改动（自恢复以来 → 当前）')
    expect(html).not.toContain('第一轮前基线')
  })

  it('baseline=resumed 预览态：同时说清「自恢复以来」与「运行中预览」', () => {
    const html = markup({ turnDiff: snapshot('resumed'), scope: 'session', preview: true })
    expect(html).toContain('自恢复以来 → 当前')
    expect(html).toContain('运行中预览')
    expect(html).not.toContain('第一轮前基线')
  })

  it('baseline=session_start：仍然是「第一轮前基线 → 当前」', () => {
    const html = markup({ turnDiff: snapshot('session_start'), scope: 'session' })
    expect(html).toContain('本会话净改动（第一轮前基线 → 当前）')
    expect(html).not.toContain('自恢复以来')
  })

  it('没有 baseline 标注的旧快照：按会话首轮前基线描述，不冒充恢复语义', () => {
    const html = markup({ turnDiff: snapshot(), scope: 'session' })
    expect(html).toContain('第一轮前基线 → 当前')
    expect(html).not.toContain('自恢复以来')
  })

  it('单轮 scope 不受基线来源影响：仍是「本轮改动」', () => {
    const html = markup({ turnDiff: snapshot('resumed') })
    expect(html).toContain('本轮改动')
    expect(html).not.toContain('自恢复以来')
    expect(html).not.toContain('第一轮前基线')
  })
})
