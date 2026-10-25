import type { ComponentProps } from 'react'
import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, ArchivedChatsPanel, McpModal, SettingsModal, SkillsModal } = shared

describe('McpModal 渲染：pending 不伪装 connected', () => {
  it('设置弹窗把当前主题呈现为可访问的单选项', () => {
    const html = renderToStaticMarkup(
      <SettingsModal theme="light" onThemeChange={() => {}} onSessionsChanged={() => {}} onNewRemoteSession={() => {}} onClose={() => {}} />
    )
    expect(html).toContain('class="modal settings-modal"')
    expect(html).toContain('role="radiogroup" aria-label="界面主题"')
    expect(html).toContain('class="theme-option active" role="radio" aria-checked="true"')
    expect(html).toContain('浅色')
    expect(html).not.toContain('立即应用到全部视图')
  })

  it('设置弹窗用左侧 tab 分区，默认停在外观', () => {
    const html = renderToStaticMarkup(
      <SettingsModal theme="dark" onThemeChange={() => {}} onSessionsChanged={() => {}} onNewRemoteSession={() => {}} onClose={() => {}} />
    )
    expect(html).toContain('class="settings-rail" aria-label="设置分区"')
    expect(html).toContain('class="settings-tab active"')
    expect(html).toContain('已存档会话')
    // 首帧还没读到索引，不展示假的 0。
    expect(html).not.toContain('<span class="cnt">0</span>')
  })

  it('已存档会话读不到索引时说明不可用，而不是显示没有存档', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel projects={null} onRefresh={async () => {}} onSessionsChanged={() => {}} />
    )
    expect(html).toContain('会话索引不可用')
    expect(html).not.toContain('没有本机已存档会话')
  })

  it('确实没有已存档会话时给出引导空态，并禁用全部删除', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel projects={[]} onRefresh={async () => {}} onSessionsChanged={() => {}} />
    )
    expect(html).toContain('没有本机已存档会话')
    expect(html).toContain('删除全部本机会话')
    expect(html).toContain('class="arch-danger" disabled=""')
  })

  it('已存档会话按项目分组，每行给出取消存档与永久删除', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel
        projects={[{
          cwd: '/Users/example/rate-native',
          name: 'rate-native',
          mtime: 2,
          sessions: [{
            sessionId: 's1',
            externalSessionId: 's1',
            providerId: 'codex',
            mtime: 2,
            preview: '迁移埋点上报 MCP',
            count: 24,
            archivedAt: Date.UTC(2026, 7, 25, 9, 12)
          }]
        }]}
        onRefresh={async () => {}}
        onSessionsChanged={() => {}}
      />
    )
    expect(html).toContain('class="arch-group-head"')
    expect(html).toContain('rate-native')
    expect(html).toContain('1 个会话')
    expect(html).toContain('迁移埋点上报 MCP')
    expect(html).toContain('24 轮')
    expect(html).toContain('存档于 2026年8月25日')
    expect(html).toContain('取消存档')
    expect(html).toContain('aria-label="永久删除：迁移埋点上报 MCP"')
  })

  it('存档时间缺失时如实标注未知', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel
        projects={[{
          cwd: '',
          name: 'Chats',
          mtime: 1,
          sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 1, preview: '临时问题', count: 1 }]
        }]}
        onRefresh={async () => {}}
        onSessionsChanged={() => {}}
      />
    )
    expect(html).toContain('存档时间未知')
  })

  it('Skill 与 MCP 首次读取立即 busy 和禁用，但首帧不显示加载、0 或空证据', () => {
    const skillHtml = renderToStaticMarkup(
      <SkillsModal
        skills={[]}
        capability={null}
        refreshing
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(skillHtml).toContain('aria-busy="true"')
    expect(skillHtml).not.toContain('读取中…')
    expect(skillHtml).not.toContain('正在读取 Skill…')
    expect(skillHtml).not.toContain('未发现')
    expect(skillHtml).not.toContain('0 个结果')
    expect(skillHtml).toContain('class="modal-refresh" disabled=""')

    const mcpHtml = renderToStaticMarkup(
      <McpModal
        mcps={[]}
        status={{}}
        live={[]}
        configRefreshing
        refreshing={false}
        capability={null}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(mcpHtml).toContain('aria-busy="true"')
    expect(mcpHtml).not.toContain('读取配置中…')
    expect(mcpHtml).not.toContain('正在读取 MCP 配置…')
    expect(mcpHtml).not.toContain('未发现 MCP')
    expect(mcpHtml).not.toContain('0 配置')
    expect(mcpHtml).toContain('class="modal-refresh" disabled=""')
  })

  it('live pending 直接显示 pending', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'github', scope: 'user', transport: 'stdio', detail: 'github mcp', enabled: true }]}
        status={{}}
        live={[{ name: 'github', status: 'pending' }]}
        refreshing={false}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('pending')
    expect(html).not.toContain('connected')
  })

  it('Fleet 把运行态与认证作为独立证据，配置只在已关闭时标注，并以 targetId 关联操作结果', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'fleet-target', name: 'fleet', scope: 'project', transport: 'http', detail: 'https://mcp.example.test', enabled: false }]}
        status={{ 'fleet-target': { ok: false, error: 'timeout', authOk: true } }}
        live={[{ name: 'fleet', status: 'connected', tools: 2 }]}
        refreshing={false}
        capability={{
          providerId: 'claude',
          cwd: '/repo',
          mode: 'manage',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: ['fleet-target'] } }
        }}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    const row = html.slice(html.indexOf('mcp-fleet__row'), html.indexOf('</tbody>'))
    expect(html).not.toContain('<th scope="col">配置</th>')
    expect(html).not.toContain('<th scope="col">本次测试</th>')
    expect(html).toContain('<th scope="col">Provider 运行态</th>')
    expect(html).toContain('<th scope="col">认证</th>')
    expect(row).toContain('inventory-scope--off')
    expect(row).toContain('已关闭')
    expect(row).toContain('已连接')
    expect(row).not.toContain('2 tools')
    expect(row).toContain('测试失败 · timeout')
    expect(row).toContain('认证成功，运行状态已刷新')
  })

  it('Pi lazy 与缓存态保持非连接语义，不伪装 connected 或 failed', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[
          { name: 'cached', scope: 'effective', transport: 'http', detail: 'https://mcp.example.test', enabled: true },
          { name: 'lazy', scope: 'effective', transport: 'stdio', detail: 'lazy-mcp', enabled: true }
        ]}
        status={{}}
        live={[
          { name: 'cached', status: 'cached', tools: 7 },
          { name: 'lazy', status: 'disconnected', tools: 0 }
        ]}
        refreshing={false}
        capability={{
          providerId: 'pi', agentProfileId: 'pi:test', cwd: '/repo', mode: 'read', state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('Pi 有效配置（合并后）')
    expect(html).toContain('aria-label="刷新 Pi MCP 快照"')
    expect(html).toContain('刷新快照')
    expect(html).toContain('不会主动连接 lazy server')
    expect(html).toContain('仅缓存元数据')
    expect(html).not.toContain('7 tools')
    expect(html).toContain('这不是实时连接证据')
    expect(html).toContain('尚未连接')
    expect(html).toContain('lazy server 尚未建立连接')
    expect(html).not.toContain('inventory-state--connected')
    expect(html).not.toContain('inventory-state--failed')
  })

  it('只读 Provider 不再展示无效的单项测试按钮，改为明确检测全部运行态', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[{ name: 'github', status: 'connected', tools: 7 }]}
        refreshing={false}
        capability={{
          providerId: 'codex',
          cwd: '/repo',
          mode: 'read',
          state: 'degraded',
          reason: '配置已读取；刷新后读取 Codex app-server 运行状态',
          data: { configured: [], runtime: null }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )

    expect(html).toContain('aria-label="检测全部 MCP 运行状态"')
    expect(html).toContain('检测全部')
    expect(html).toContain('已连接')
    expect(html).not.toContain('7 tools')
    expect(html).not.toContain('测试连接')
    expect(html).toContain('不提供单项直测')
  })

  it('检测全部与逐项直测始终展示进行中和最终结果', () => {
    const refreshingHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[]}
        refreshing
        capability={{
          providerId: 'codex',
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
    expect(refreshingHtml).toContain('aria-busy="true"')
    expect(refreshingHtml).not.toContain('正在检测全部 MCP…')
    expect(refreshingHtml).not.toContain('检测中…')
    expect(refreshingHtml).toMatch(/class="modal-refresh mcp-refresh-all"[^>]*disabled=""/)
    expect(refreshingHtml).toContain('aria-label="检测全部 MCP 运行状态"')

    const failedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { ok: false, error: 'initialize timeout' } }}
        live={[{ name: 'github', status: 'connected', tools: 3 }]}
        refreshing={false}
        capability={{
          providerId: 'claude',
          cwd: '/repo',
          mode: 'manage',
          state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(failedHtml).toContain('connected')
    expect(failedHtml).toContain('role="alert"')
    expect(failedHtml).toContain('测试失败 · initialize timeout')
    expect(failedHtml).toContain('title="本次测试失败 · initialize timeout"')
  })

  it('仅对 Provider 声明支持的 needs-auth 目标提供重新认证与可访问反馈', () => {
    const capability: ComponentProps<typeof McpModal>['capability'] = {
      providerId: 'codex',
      cwd: '/repo',
      mode: 'read',
      state: 'ready',
      data: {
        configured: [],
        runtime: [],
        operations: { authenticate: ['github-target'] }
      }
    }
    const authenticatingHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: true } }}
        live={[{ name: 'github', status: 'needs-auth' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(authenticatingHtml).toContain('aria-label="重新认证 MCP github"')
    expect(authenticatingHtml).toMatch(/<button class="mcp-test" disabled="" aria-label="重新认证 MCP github">/)
    expect(authenticatingHtml).toContain('等待浏览器完成授权…')
    expect(authenticatingHtml).toContain('role="status" aria-live="polite"')

    const successHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: false, authOk: true } }}
        live={[{ name: 'github', status: 'connected' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(successHtml).toContain('认证成功，运行状态已刷新')
    expect(successHtml).not.toContain('aria-label="重新认证 MCP github"')

    const unverifiedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: false, authOk: true, authError: '连接状态仍为 pending' } }}
        live={[{ name: 'github', status: 'needs-auth' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(unverifiedHtml).toContain('授权流程已完成；运行状态未确认 · 连接状态仍为 pending')
    expect(unverifiedHtml).toContain('role="status" aria-live="polite"')

    const failedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: false, authOk: false, authError: '用户取消授权' } }}
        live={[{ name: 'github', status: 'needs-auth' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(failedHtml).toContain('role="alert" aria-live="polite"')
    expect(failedHtml).toContain('认证失败 · 用户取消授权')
  })

  it('OAuth Client 未注册和不支持认证的 Provider 只展示被动指引', () => {
    const clientRegistrationHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'remote-target', name: 'remote', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[{ name: 'remote', status: 'needs-client-registration' }]}
        refreshing={false}
        capability={{
          providerId: 'opencode',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: ['remote-target'] } }
        }}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(clientRegistrationHtml).toContain('需配置 OAuth Client')
    expect(clientRegistrationHtml).toContain('需在 Provider 中配置 OAuth Client ID')
    expect(clientRegistrationHtml).not.toContain('aria-label="重新认证 MCP remote"')

    const unsupportedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'remote-target', name: 'remote', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[{ name: 'remote', status: 'needs-auth' }]}
        refreshing={false}
        capability={{
          providerId: 'claude',
          cwd: '/repo',
          mode: 'manage',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: [] } }
        }}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(unsupportedHtml).toContain('请在 Provider 客户端完成认证')
    expect(unsupportedHtml).not.toContain('aria-label="重新认证 MCP remote"')
  })
})