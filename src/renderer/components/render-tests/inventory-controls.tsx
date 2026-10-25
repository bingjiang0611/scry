import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, filterSkillsForScope, McpModal, SkillsModal } = shared

describe('Skill/MCP 操作能力渲染', () => {
  it('Skill 清单只呈现发现结果，不渲染配置状态、开关与账号证据', () => {
    const html = renderToStaticMarkup(
      <SkillsModal
        skills={[
          { name: 'scry-e2e-audit', dir: '/skill', scope: 'project', description: 'audit', enabled: true },
          { name: 'user-home', dir: '/home-skill', scope: 'user', description: 'shared', enabled: true }
        ]}
        capability={{ providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [] }}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('class="inventory-switch"')
    expect(html).not.toContain('skill-ledger__status')
    expect(html).not.toContain('配置状态')
    expect(html).not.toContain('inventory-account')
    expect(html).toContain('inventory-modal--skills')
    expect(html).toContain('aria-label="Skills 查询上下文"')
    expect(html).toContain('<strong>qoder</strong>')
    expect(html).toContain('<code title="/repo">/repo</code>')
    expect(html).toContain('尚未观测')
    expect(html).toContain('1 个结果')
    expect(html).toContain('发现证据')
    expect(html).toContain('Scry 只读取、不改写 Skill 配置')
    expect(html).toContain('role="tablist" aria-label="Skill 来源"')
    expect(html).toContain('项目 Skill <span>1</span>')
    expect(html).toContain('用户 Skill <span>1</span>')
    expect(html).not.toContain('user-home')
    expect(filterSkillsForScope([
      { name: 'project-audit', dir: '/repo', scope: 'project', description: 'audit', enabled: true },
      { name: 'user-home', dir: '/home', scope: 'user', description: 'shared', enabled: true }
    ], 'user')).toEqual([{ name: 'user-home', dir: '/home', scope: 'user', description: 'shared', enabled: true }])
  })

  it('不丢弃 Provider 原生 Skill scope', () => {
    const providerSkill = {
      name: 'scry-e2e-audit',
      dir: '/repo/.opencode/skills/scry-e2e-audit',
      scope: 'opencode',
      description: 'Repository audit',
      enabled: true
    }
    const html = renderToStaticMarkup(
      <SkillsModal
        skills={[providerSkill]}
        capability={{ providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [providerSkill] }}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )

    expect(filterSkillsForScope([providerSkill], 'provider')).toEqual([providerSkill])
    expect(html).toContain('Provider Skill <span>1</span>')
    expect(html).toContain('scry-e2e-audit')
    expect(html).toContain('inventory-scope--unknown')
  })

  it('可管理 Provider 也不再渲染 Skill 开关，MCP 面板保持 connected 真值', () => {
    const skillHtml = renderToStaticMarkup(
      <SkillsModal
        skills={[{ name: 'scry-e2e-audit', dir: '/skill', scope: 'project', description: 'audit', enabled: false }]}
        capability={{ providerId: 'claude', cwd: '/repo', mode: 'manage', state: 'ready', data: [] }}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(skillHtml).not.toContain('type="checkbox"')
    expect(skillHtml).not.toContain('已关闭')
    expect(skillHtml).not.toContain('可管理')

    const mcpHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'scry-e2e', scope: 'project', transport: 'stdio', detail: 'fixture', enabled: true }]}
        status={{}}
        live={[{ name: 'scry-e2e', status: 'connected', tools: 3 }]}
        refreshing={false}
        capability={{
          providerId: 'opencode',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(mcpHtml).not.toContain('type="checkbox"')
    expect(mcpHtml).not.toContain('运行态只读')
    expect(mcpHtml).toContain('aria-label="MCP 查询上下文"')
    expect(mcpHtml).toContain('<strong>opencode</strong>')
    expect(mcpHtml).toContain('<code title="/repo">/repo</code>')
    expect(mcpHtml).toContain('connected')
    expect(mcpHtml).toContain('只暴露原生 MCP 配置/运行状态')
  })
})