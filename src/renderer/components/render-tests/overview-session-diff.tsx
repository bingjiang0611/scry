import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, OverviewPanel, ev } = shared
type Turn = shared.Turn

describe('OverviewPanel 本会话改动：来自各轮 turnDiff 累计，不冒充工作区 diff', () => {
  const diffTurn = (runId: string, files: { path: string; added: number; deleted: number }[]): Turn => ({
    runId,
    userText: `轮 ${runId}`,
    done: true,
    items: [
      ev({
        id: `${runId}-diff`,
        runId,
        kind: 'harness',
        stage: 'turn_diff',
        turnDiff: {
          version: 1,
          status: 'captured',
          files,
          repoRoot: '/repo',
          scope: '.',
          beforeAt: '2026-08-10T00:00:00.000Z',
          afterAt: '2026-08-10T00:00:01.000Z',
          captureMs: 7,
          cleanup: 'ok'
        }
      })
    ]
  })
  const turns = [
    diffTurn('r1', [{ path: '/repo/src/a.ts', added: 3, deleted: 1 }, { path: '/repo/src/b.ts', added: 2, deleted: 0 }]),
    diffTurn('r2', [{ path: '/repo/src/a.ts', added: 5, deleted: 4 }])
  ]

  it('汇总 unique files 与各轮累计 +/−，并标明是累计活动量', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={turns}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        onOpenSessionDiff={() => {}}
      />
    )
    expect(html).toContain('本会话活动（2 轮快照累计）')
    expect(html).toContain('2 files · +10 −5')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('>+8<')
    expect(html).toContain('>−5<')
    expect(html).toContain('2 轮')
    expect(html).toContain('+/− 是累计活动量，不是当前工作树净改动')
    expect(html).toContain('gdrow click')
  })

  it('工作区未提交改动仍是独立段，两个数字不互相顶替', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={turns}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        gitDiff={{ status: 'captured', files: [{ path: '/repo/src/a.ts', added: 4, deleted: 5 }] }}
        onOpenSessionDiff={() => {}}
      />
    )
    expect(html).toContain('本会话活动（2 轮快照累计）')
    expect(html).toContain('2 files · +10 −5')
    expect(html).toContain('工作区未提交改动（vs HEAD）')
    expect(html).toContain('1 files · +4 −5')
  })

  it('没有 onOpenSessionDiff 时不渲染假可点行', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel turns={turns} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )
    expect(html).toContain('本会话活动（2 轮快照累计）')
    expect(html).not.toContain('gdrow click')
  })
})