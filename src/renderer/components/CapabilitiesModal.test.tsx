import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CapabilitiesModal } from './CapabilitiesModal'
import type { CapabilityEnvelope, McpSnapshot, SkillMeta } from '@shared/provider'

// Evidence honesty (CLAUDE.md): a list the Provider could not read is unavailable, not
// empty. Verification of c860e7f showed "当前来源没有 MCP" under "Claude Code executable 未找到".

const base = {
  onViewChange: vi.fn(), skills: [], onRefreshSkills: vi.fn(), mcps: [], status: {}, live: [],
  mcpRefreshing: false, onTestMcp: vi.fn(), onRefreshMcp: vi.fn(), onClose: vi.fn()
}

describe('CapabilitiesModal empty states', () => {
  it('does not call an unread MCP list empty', () => {
    const mcpCapability = { providerId: 'claude', mode: 'none', state: 'unknown', data: null, reason: 'Claude Code executable 未找到' } as CapabilityEnvelope<McpSnapshot>
    const html = renderToStaticMarkup(<CapabilitiesModal {...base} view="mcp" mcpCapability={mcpCapability} />)
    expect(html).not.toContain('当前来源没有 MCP')
    expect(html).toContain('未能读取当前来源的 MCP')
  })

  it('still says empty when the list was read and is empty', () => {
    const mcpCapability = { providerId: 'claude', mode: 'read', state: 'ready', data: { configured: [], live: [] } } as unknown as CapabilityEnvelope<McpSnapshot>
    const html = renderToStaticMarkup(<CapabilitiesModal {...base} view="mcp" mcpCapability={mcpCapability} />)
    expect(html).toContain('当前来源没有 MCP')
  })

  it('does not call an unsupported Skill list empty', () => {
    const skillCapability = { providerId: 'claude', mode: 'none', state: 'unsupported', data: null, reason: '该 Provider 没有可用的 Skill 读取接口' } as CapabilityEnvelope<SkillMeta[]>
    const html = renderToStaticMarkup(<CapabilitiesModal {...base} view="skills" skillCapability={skillCapability} />)
    expect(html).not.toContain('当前来源没有 Skill')
    expect(html).toContain('未能读取当前来源的 Skill')
  })
})
