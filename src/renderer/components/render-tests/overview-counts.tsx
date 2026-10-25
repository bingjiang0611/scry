import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, OverviewPanel, ev, turn } = shared
type Turn = shared.Turn

describe('OverviewPanel compact count', () => {
  it('展示当前会话的 compact 次数', () => {
    const compactTurn: Turn = {
      ...turn,
      items: [
        ...turn.items,
        ev({ id: 'compact-1', kind: 'harness', stage: 'context_compaction', compaction: { trigger: 'auto' } })
      ]
    }
    const html = renderToStaticMarkup(
      <OverviewPanel turns={[compactTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(html).toContain('<strong class="overview-session-count">1</strong>')
  })
})