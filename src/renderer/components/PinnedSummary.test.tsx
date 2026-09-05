import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CapabilityEnvelope, McpSnapshot, SkillMeta } from '@shared/provider'
import type { Turn } from '../format'
import { PinnedSummary, webSourcesFromTurns } from './PinnedSummary'

const turn = (userText: string, input?: unknown): Turn => ({
  runId: 'run-1',
  userText,
  done: true,
  items: input == null
    ? []
    : [{ id: 'event-1', runId: 'run-1', ts: '', kind: 'tool', stage: 'tool:Bash', input }]
})

const skillCapability: CapabilityEnvelope<SkillMeta[]> = {
  providerId: 'claude',
  mode: 'read',
  state: 'ready',
  data: [{ name: 'baoyu-design', dir: '/skills/baoyu-design', scope: 'user', description: 'Design', enabled: true }]
}

const mcpCapability: CapabilityEnvelope<McpSnapshot> = {
  providerId: 'claude',
  mode: 'read',
  state: 'ready',
  data: {
    configured: [{ name: 'browser', scope: 'user', transport: 'stdio', detail: 'browser server', enabled: true }],
    runtime: []
  }
}

const callbacks = {
  onDismiss: () => undefined,
  onOpenChanges: () => undefined,
  onOpenSkills: () => undefined,
  onOpenMcp: () => undefined,
  onOpenAgents: () => undefined
}

describe('PinnedSummary', () => {
  it('renders only evidence-backed counts and the current workspace inventory', () => {
    const html = renderToStaticMarkup(
      <PinnedSummary
        cwd="/repo/scry"
        gitDiff={[{ path: '/repo/scry/a.ts', added: 12, deleted: 3 }]}
        skills={skillCapability.data ?? []}
        skillCapability={skillCapability}
        mcps={mcpCapability.data?.configured ?? []}
        mcpCapability={mcpCapability}
        turns={[turn('参考 https://example.com/docs。')]}
        busy={false}
        temporary={false}
        {...callbacks}
      />
    )

    expect(html).toContain('aria-label="固定摘要"')
    expect(html).toContain('+12')
    expect(html).toContain('−3')
    expect(html).toContain('scry')
    expect(html).toContain('baoyu-design')
    expect(html).toContain('browser')
    expect(html).toContain('>2<')
  })

  it('keeps unavailable inventory and unobserved agents distinct from real zero', () => {
    const unavailableSkills: CapabilityEnvelope<SkillMeta[]> = {
      providerId: 'pi',
      mode: 'none',
      state: 'unsupported',
      data: null,
      reason: 'Pi 未提供 Skill 清单'
    }
    const unavailableMcp: CapabilityEnvelope<McpSnapshot> = {
      providerId: 'pi',
      mode: 'none',
      state: 'unsupported',
      data: null,
      reason: 'Pi 未提供 MCP 状态 API'
    }
    const html = renderToStaticMarkup(
      <PinnedSummary
        cwd={null}
        gitDiff={[]}
        skills={[]}
        skillCapability={unavailableSkills}
        mcps={[]}
        mcpCapability={unavailableMcp}
        turns={[]}
        busy={false}
        temporary
        {...callbacks}
      />
    )

    expect(html).toContain('Pi 未提供 Skill 清单')
    expect(html).toContain('Pi 未提供 MCP 状态 API')
    expect(html).toContain('data-evidence="unavailable">—')
    expect(html).toContain('data-evidence="unknown">—')
    expect(html).not.toContain('Subagents</span><span class="pinned-summary-row-value"><span class="pinned-summary-count" data-evidence="unknown">0')
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
