import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Turn } from '../format'
import { PinnedSummary, usePinnedSummaryVisibility, webSourcesFromTurns, type PinnedSummarySection, type PinnedSummaryProps } from './PinnedSummary'
import { OverviewPanel } from './OverviewPanel'

const turn = (userText: string, input?: unknown): Turn => ({
  runId: 'run-1',
  userText,
  done: true,
  items: input == null
    ? []
    : [{ id: 'event-1', runId: 'run-1', ts: '', kind: 'tool', stage: 'tool:Bash', input }]
})

const callbacks = {
  onDismiss: () => undefined,
  onToggleSection: () => undefined,
  onOpenChanges: () => undefined,
  onOpenCall: () => undefined,
  onOpenAgents: () => undefined
}

const session: Turn = {
  ...turn('参考 https://example.com/docs。'),
  items: [
    { id: 'skill', runId: 'run-1', ts: '', kind: 'skill', stage: 'skill:used-workflow', name: 'used-workflow', toolUseId: 's1' },
    { id: 'mcp', runId: 'run-1', ts: '', kind: 'tool', stage: 'tool:mcp__browser__navigate', tool: 'mcp__browser__navigate', isMcp: true, toolUseId: 'm1' }
  ]
}

const render = (
  turns: Turn[],
  expandedSections: ReadonlySet<PinnedSummarySection> = new Set(['inventory']),
  gitDiff: PinnedSummaryProps['gitDiff'] = { status: 'captured', files: [{ path: '/repo/scry/a.ts', added: 12, deleted: 3 }] }
) => renderToStaticMarkup(
  <PinnedSummary
    cwd="/repo/scry"
    gitDiff={gitDiff}
    turns={turns}
    busy={false}
    temporary={false}
    expandedSections={expandedSections}
    {...callbacks}
  />
)

describe('PinnedSummary', () => {
  it.each([false, true])('defaults to hidden regardless of panel visibility (%s)', (panelVisible) => {
    function InitialVisibility() {
      const state = usePinnedSummaryVisibility(true, panelVisible)
      return <span data-visible={state.visible} />
    }
    expect(renderToStaticMarkup(<InitialVisibility />)).toContain('data-visible="false"')
  })

  it('agrees with Overview on Qoder user-requested Skill loading without showing inference metadata in the compact row', () => {
    const read = {
      id: 'qoder-read', runId: 'run-1', ts: '', kind: 'tool' as const, stage: 'tool:Read',
      tool: 'Read', toolUseId: 'read-1', filePath: '/repo/rate-native/.claude/skills/hsf-invoke/SKILL.md'
    }
    const loaded: Turn = {
      ...turn('/rate-native-hsf-invoke 查询接口'),
      items: [read, { ...read, id: 'qoder-result', stage: 'tool_result', isError: false }]
    }
    const pinned = render([loaded])
    expect(pinned).toContain('hsf-invoke')
    expect(pinned).toContain('<em>×1</em>')
    expect(pinned).not.toContain('<em>×1 · 加载推断</em>')
    expect(pinned).toContain('非原生 Skill 调用')
    const overview = renderToStaticMarkup(<OverviewPanel turns={[loaded]} selected={null} onSelect={() => undefined} usage={null} stats={null} />)
    expect(overview).toContain('hsf-invoke（含加载推断）')
    expect(overview).not.toContain('尚未观测到 Skill 调用或加载证据')
  })

  it('shows observed calls in this session, not the workspace inventory or connection status', () => {
    const html = render([session])
    expect(html).toContain('aria-label="固定摘要"')
    expect(html).toContain('+12')
    expect(html).toContain('−3')
    expect(html).toContain('Skills &amp; MCP · 本会话')
    expect(html).toContain('used-workflow')
    expect(html).toContain('browser / navigate')
    expect(html).toContain('>2<')
    expect(html).toContain('×1')
    expect(html).toContain('点击定位会话证据')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('已连接')
  })

  it('omits unobserved Context groups and their heading instead of asserting zero calls', () => {
    for (const turns of [[], [turn('提到 used-workflow 不等于调用')]]) {
      const html = render(turns)
      expect(html).not.toContain('Skills &amp; MCP · 本会话')
      expect(html).not.toContain('Web references')
      expect(html).not.toContain('Subagents')
      expect(html).not.toContain('>Context<')
      expect(html).not.toContain('pinned-summary-divider')
      expect(html).not.toContain('尚未观测到')
      expect(html).not.toContain('>0<')
      expect(html).toContain('>Environment<')
      expect(html).toContain('>scry</span>')
    }
  })

  it('shows successful empty Git evidence without confusing it with missing data', () => {
    const html = render([], new Set(), { status: 'captured', files: [] })
    expect(html).toContain('>Changes<')
    expect(html).toContain('data-evidence="captured"')
    expect(html).toContain('无改动')
    expect(html).not.toContain('additions')
    expect(html).not.toContain('deletions')
    expect(html).toContain('>scry</span>')
  })

  it.each([
    [{ status: 'unavailable', reason: 'not_git', files: [] }, '不可用'],
    [{ status: 'timeout', reason: 'deadline', files: [] }, '采集超时'],
    [{ status: 'failed', reason: 'request_failed', files: [] }, '采集失败'],
    [null, '采集中']
  ] as const)('keeps non-successful Git evidence visible in summary and Overview (%s)', (diff, label) => {
    const result = diff ? { ...diff, files: [] as [] } : null
    const pinned = render([], new Set(), result)
    const overview = renderToStaticMarkup(<OverviewPanel turns={[]} selected={null} onSelect={() => undefined} usage={null} stats={null} gitDiff={result} />)
    for (const html of [pinned, overview]) {
      expect(html).toContain(label)
      expect(html).not.toContain('无改动')
      expect(html).not.toContain('>+0<')
      expect(html).not.toContain('data-evidence="captured"')
    }
  })

  it('shows only populated Context groups', () => {
    const onlySkill = render([{ ...session, userText: '', items: session.items.slice(0, 1) }])
    expect(onlySkill).toContain('Skills &amp; MCP · 本会话')
    expect(onlySkill).toContain('未观测到不等于未调用')
    expect(onlySkill).not.toContain('Web references')
    expect(onlySkill).not.toContain('Subagents')

    const onlyAgent = render([{
      ...turn('调查代码'),
      items: [{ id: 'agent', runId: 'run-1', ts: '', kind: 'agent', stage: 'agent:research', tool: 'Agent', toolUseId: 'a1', name: 'research' }]
    }], new Set(['agents']))
    expect(onlyAgent).toContain('Subagents')
    expect(onlyAgent).toContain('research')
    expect(onlyAgent).toContain('>1</span>')
    expect(onlyAgent).toContain('>Context<')
    expect(onlyAgent).not.toContain('Skills &amp; MCP · 本会话')
    expect(onlyAgent).not.toContain('Web references')

    const onlyWeb = render([turn('https://example.com/docs')], new Set(['web']))
    expect(onlyWeb).toContain('Web references')
    expect(onlyWeb).toContain('>Context<')
    expect(onlyWeb).not.toContain('Skills &amp; MCP · 本会话')
    expect(onlyWeb).not.toContain('Subagents')
  })

  it('hides Web references without actual URLs', () => {
    const bounded = render([turn('x'.repeat(120_001))])
    expect(bounded).not.toContain('Web references')

    const withWeb = render([session], new Set(['web']))
    const webLabel = withWeb.indexOf('Web references')
    const webStart = withWeb.lastIndexOf('<section', webLabel)
    const webSection = withWeb.slice(webStart, withWeb.indexOf('</section>', webLabel))
    expect(webSection).toContain('>1</span>')
    expect(webSection).toContain('aria-expanded="true"')
  })

  it('links each disclosure button to a stable detail region', () => {
    const html = render([session])
    const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1])
    expect(controls).toHaveLength(2)
    for (const id of controls) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('hidden=""')
  })

  it('deduplicates rows and labels observed kinds separately from invocation counts', () => {
    const html = render([session, { ...session, runId: 'run-2' }])
    expect(html).toContain('种类数，非配置数量')
    expect(html).toContain('×2')
    expect(html.match(/<span>used-workflow<\/span>/g)).toHaveLength(1)
    expect(html.match(/<span>browser \/ navigate<\/span>/g)).toHaveLength(1)
  })

  it('deduplicates and bounds web references from loaded transcript evidence', () => {
    const sources = webSourcesFromTurns([
      turn('https://example.com/a), https://example.com/a', { command: 'curl https://docs.example.com/path?q=1' }),
      turn('https://third.example.test/read')
    ])
    expect(sources).toEqual([
      { url: 'https://example.com/a', label: 'example.com/a' },
      { url: 'https://docs.example.com/path?q=1', label: 'docs.example.com/path' },
      { url: 'https://third.example.test/read', label: 'third.example.test/read' }
    ])
  })
})
