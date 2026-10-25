import type { ComponentProps } from 'react'
import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, CapabilitiesModal } = shared

describe('CapabilitiesModal 精简能力页', () => {
  const sharedProps: ComponentProps<typeof CapabilitiesModal> = {
    view: 'skills',
    onViewChange: () => {},
    skills: [],
    onRefreshSkills: () => {},
    skillCapability: { providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [] },
    mcps: [],
    status: {},
    live: [],
    mcpRefreshing: false,
    mcpCapability: {
      providerId: 'qoder',
      cwd: '/repo',
      mode: 'read',
      state: 'ready',
      data: { configured: [], runtime: [], operations: { authenticate: [] } }
    },
    onTestMcp: () => {},
    onRefreshMcp: () => {},
    onClose: () => {}
  }

  it('Skills 默认显示全部来源，只保留名称和描述', () => {
    const html = renderToStaticMarkup(
      <CapabilitiesModal
        {...sharedProps}
        skills={[
          { name: 'project-skill', dir: '/repo/SKILL.md', scope: 'project', description: '项目能力说明', enabled: true },
          { name: 'provider-skill', dir: 'qoder:builtin', scope: 'qoder', description: 'Provider 能力', enabled: true }
        ]}
      />
    )

    expect(html).toContain('role="tablist" aria-label="能力类型"')
    expect(html).toContain('role="tablist" aria-label="Skill 来源"')
    expect(html).toContain('aria-selected="true" class="active">全部</button>')
    expect(html).toContain('项目能力说明')
    expect(html).toContain('Provider 能力')
    expect(html).not.toContain('/repo/SKILL.md')
    expect(html).not.toContain('搜索')
    expect(html).not.toContain('个结果')
    expect(html).not.toContain('刷新 MCP 运行状态')
  })

  it('MCP 不显示列头和工具数量，已关闭归入运行态，并保留真实工具明细与状态认证按钮', () => {
    const html = renderToStaticMarkup(
      <CapabilitiesModal
        {...sharedProps}
        view="mcp"
        mcps={[
          { targetId: 'connected-target', name: 'connected', scope: 'project', transport: 'http', detail: 'https://mcp.example.test', enabled: true },
          { targetId: 'auth-target', name: 'auth', scope: 'project', transport: 'http', detail: 'https://auth.example.test', enabled: true },
          { targetId: 'disabled-target', name: 'disabled', scope: 'project', transport: 'stdio', detail: 'disabled', enabled: false }
        ]}
        live={[
          { name: 'connected', status: 'connected', tools: 2, toolNames: ['tool_a', 'tool_b'] },
          { name: 'auth', status: 'needs-auth' }
        ]}
        mcpCapability={{
          providerId: 'qoder',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: ['auth-target'] } }
        }}
        onReauthenticateMcp={() => {}}
      />
    )

    expect(html).not.toContain('<table')
    expect(html).not.toContain('Server / 来源')
    expect(html).not.toContain('Provider 运行态')
    expect(html).not.toContain('2 tools')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('tool_a')
    expect(html).toContain('tool_b')
    expect(html).toContain('inventory-state--disabled')
    expect(html).toContain('已关闭')
    expect(html).toContain('class="capability-auth capability-auth--required"')
    expect(html).toContain('需要认证')
  })
})