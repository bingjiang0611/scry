// Diff Review 头部文案的诚实性回归：会话净 diff 的基线可能是「会话首轮前」，
// 也可能是恢复该会话时当场重锚的（baseline='resumed'）。后者只覆盖「自恢复以来」，
// 面板绝不能继续写「第一轮前基线 → 当前」。renderToStaticMarkup 纯 node 跑，无需 DOM。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TurnDiffBaselineOrigin, TurnDiffSnapshot } from '@shared/trace'
import type { TurnDiffReview } from '../turn-diff'
import { parseUnifiedDiff, TurnDiffReviewPanel } from './TurnDiffReviewPanel'

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

it('does not mistake +++/--- code inside a hunk for file headers', () => {
  const lines = parseUnifiedDiff('--- a/file\n+++ b/file\n@@ -4 +4 @@\n---old\n+++new')
  expect(lines[0].kind).toBe('meta')
  expect(lines[1].kind).toBe('meta')
  expect(lines[3]).toMatchObject({ kind: 'del', oldLine: 4 })
  expect(lines[4]).toMatchObject({ kind: 'add', newLine: 4 })
})

it('resets line provenance at the next file boundary', () => {
  const lines = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\ndiff --git a/next b/next\n--- a/next\n+++ b/next')
  expect(lines.slice(-2).map(line => line.kind)).toEqual(['meta', 'meta'])
})

describe('TurnDiffReviewPanel 会话基线文案', () => {
  it('baseline=resumed 终态：说「自恢复以来」，不说「第一轮前基线」', () => {
    const html = markup({ turnDiff: snapshot('resumed'), scope: 'session' })
    expect(html).toContain('<b title="run-1">本会话净改动</b>')
    expect(html).toContain('<span>自恢复以来 → 当前</span>')
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
    expect(html).toContain('<b title="run-1">本会话净改动</b>')
    expect(html).toContain('<span>第一轮前基线 → 当前</span>')
    expect(html).not.toContain('自恢复以来')
  })

  it('没有 baseline 标注的旧快照：按会话首轮前基线描述，不冒充恢复语义', () => {
    const html = markup({ turnDiff: snapshot(), scope: 'session' })
    expect(html).toContain('第一轮前基线 → 当前')
    expect(html).not.toContain('自恢复以来')
  })

  it('单轮 scope 不受基线来源影响：仍是「本轮改动」', () => {
    const html = markup({ turnDiff: snapshot('resumed') })
    expect(html).toContain('<b title="run-1">本轮改动</b>')
    expect(html).not.toContain('本轮改动 · run-1')
    expect(html).not.toContain('>run-1<')
    expect(html).not.toContain('自恢复以来')
    expect(html).not.toContain('第一轮前基线')
  })

  it.each(['turn', 'session'] as const)('%s 预览保留标题标识，但不显示临时快照横幅', (scope) => {
    const html = markup({ turnDiff: snapshot(), scope, preview: true })
    expect(html).toContain('运行中预览')
    expect(html).not.toContain('运行中的临时 Git 快照')
    expect(html).not.toContain('diff-review-notice')
  })

  it('预览仍显示 patch 截断警告', () => {
    const turnDiff = snapshot()
    turnDiff.files[0].patchStatus = 'truncated'
    const html = markup({ turnDiff, preview: true })
    expect(html).toContain('该文件 patch 已按本轮预算截断')
    expect(html).toContain('diff-review-notice warn')
  })

  it('文件导航显式显示完整条目数，避免窄栏只露出前三项时被误认成缺数据', () => {
    const turnDiff = snapshot()
    turnDiff.files = Array.from({ length: 17 }, (_, index) => ({
      path: `/repo/file-${index + 1}.ts`,
      added: index + 1,
      deleted: 0
    }))

    const html = markup({ turnDiff })
    expect(html).toContain('<span>Files</span><span>17</span>')
    expect((html.match(/title="\/repo\/file-/g) ?? []).length).toBe(17)
    expect(html).toContain('/repo/file-17.ts')
  })
})
