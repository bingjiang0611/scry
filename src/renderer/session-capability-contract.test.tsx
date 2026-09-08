import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { qoderSkillSessionFixture } from './__fixtures__/session-capabilities'
import { aggregateCalls, logicalCallEventsForTurn } from './format'
import { sessionCapabilityCalls } from './session-capability-calls'
import { PinnedSummary } from './components/PinnedSummary'
import { OverviewPanel } from './components/OverviewPanel'

// This contract crosses normalization, archive serialization, call projection and both
// consumers. Hand-authored kind:'skill' events would conceal the original regression.
describe('normalized historical session capability contract', () => {
  it.each(['pending', 'success', 'failed'] as const)('keeps both views consistent after %s results and archive reload', (outcome) => {
    const turn = qoderSkillSessionFixture('fixture-run', outcome)
    expect(turn.items.some((event) => event.kind === 'skill')).toBe(false)
    const reloaded = JSON.parse(JSON.stringify(turn)) as typeof turn
    const before = JSON.stringify(reloaded)
    const counts = aggregateCalls(logicalCallEventsForTurn(reloaded.items, reloaded.userText))
    const rows = sessionCapabilityCalls([reloaded])
    expect(counts).toMatchObject({ totalCalls: 2, skillTotal: outcome === 'success' ? 1 : 0, mcpTotal: 1 })
    const skill = rows.find((row) => row.kind === 'skill')
    if (outcome === 'success') {
      expect(skill).toMatchObject({ name: 'hsf-invoke', count: 1, inferredCount: 1, event: { kind: 'tool', tool: 'Read', toolUseId: 'read-1' } })
      expect(skill?.event.input).not.toHaveProperty('source')
    } else expect(skill).toBeUndefined()
    const pinned = renderToStaticMarkup(<PinnedSummary cwd={null} gitDiff={[]} turns={[reloaded]} busy={false} temporary={false} expandedSections={new Set(['inventory'])} onDismiss={() => undefined} onToggleSection={() => undefined} onOpenCall={() => undefined} onOpenAgents={() => undefined} />)
    const overview = renderToStaticMarkup(<OverviewPanel turns={[reloaded]} selected={null} onSelect={() => undefined} usage={null} stats={null} />)
    expect(pinned.includes('×1 · 加载推断')).toBe(outcome === 'success')
    expect(overview.includes('Skill 1（含加载推断）')).toBe(outcome === 'success')
    expect(pinned).toContain('browser / navigate')
    expect(JSON.stringify(reloaded)).toBe(before)
  })

  it('counts reused native ids across turns but not duplicate stream events within a turn', () => {
    const a = qoderSkillSessionFixture('run-a')
    const b = qoderSkillSessionFixture('run-b')
    const read = a.items.find((event) => event.toolUseId === 'read-1')!
    const mcp = a.items.find((event) => event.toolUseId === 'mcp-1')!
    a.items.push({ ...read, id: 'read-progress' }, { ...mcp, id: 'mcp-progress' })
    expect(sessionCapabilityCalls([a, b]).map(({ name, count }) => ({ name, count }))).toEqual([
      { name: 'hsf-invoke', count: 2 }, { name: 'browser / navigate', count: 2 }
    ])
  })
})
