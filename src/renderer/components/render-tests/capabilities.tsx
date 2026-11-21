import type { ComponentProps } from 'react'
import * as shared from './shared'
import { McpTrustPanel } from '../McpTrustPanel'
import { CliPicker } from '../CliPicker'
import { ToolItem } from '../ChatTurnToolItem'
import { PROVIDER_BRAND_MARKS } from '../../provider-brand-marks'
const { describe, it, expect, renderToStaticMarkup, CapabilitiesModal, AssistantTurn, ev } = shared

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

  it('MCP 检测只为能真正停止的 Provider 提供取消，其余不显示取消按钮', () => {
    const during = (providerId: 'claude' | 'qoder' | 'codex' | 'opencode' | 'pi' | 'antigravity') => renderToStaticMarkup(
      <CapabilitiesModal {...sharedProps} view="mcp" mcpRefreshing mcpProviderId={providerId} onCancelMcp={async () => true} />
    )
    expect(during('claude')).toContain('取消检测')
    expect(during('qoder')).toContain('取消检测')
    for (const providerId of ['codex', 'opencode', 'pi', 'antigravity'] as const) expect(during(providerId)).not.toContain('取消检测')
    const idle = renderToStaticMarkup(<CapabilitiesModal {...sharedProps} view="mcp" mcpProviderId="claude" onCancelMcp={async () => true} />)
    expect(idle).not.toContain('取消检测')
  })

  it('Antigravity 菜单只显示名称，MCP 保留信任风险但不显示额外说明', () => {
    expect(PROVIDER_BRAND_MARKS.antigravity.paths.length).toBeGreaterThan(0)
    const html = renderToStaticMarkup(<McpTrustPanel runtimeProvider="antigravity_acp" />)
    expect(html).toContain('Antigravity')
    expect(html).toContain('~/.gemini/config/mcp_config.json')
    expect(html).toContain('~/.gemini/config/hooks.json')
    expect(html).toContain('TOCTOU')
    expect(html).not.toMatch(/账号未验证|条款提示|运行边界/)

    const pickerHtml = renderToStaticMarkup(
      <CliPicker
        open
        agents={[{
          id: 'antigravity',
          name: 'Antigravity',
          bin: 'agy',
          path: '/usr/local/bin/agy',
          version: '1.5.13',
          accountNote: '账号未验证'
        }]}
        selectedId="antigravity"
        onSelect={() => {}}
      />
    )
    expect(pickerHtml).toContain('<span class="agent-option-name">Antigravity</span>')
    expect(pickerHtml).not.toMatch(/账号未验证|条款提示|运行边界/)
  })

  it('Antigravity 保留用量、模型与工具审批证据，但不展示整轮用户规则清单', () => {
    const partialTurn: shared.Turn = {
      runId: 'run-agy-ui-1',
      userText: 'check',
      done: true,
      items: [
        ev({
          id: 'agy-tool-1',
          kind: 'tool',
          stage: 'tool:run_command',
          tool: 'run_command',
          runtimeProvider: 'antigravity_acp',
          runtimeMetadata: { approvalSource: 'hook', approvalLabel: '由 hook 放行' }
        }),
        ev({
          id: 'agy-result-1',
          kind: 'harness',
          stage: 'result',
          providerId: 'antigravity',
          runtimeProvider: 'antigravity_acp',
          tokensIn: 120,
          tokensOut: 40,
          runtimeMetadata: {
            usageCoverage: 'partial',
            usageCoverageReason: '本轮包含 invoke_subagent 子 Agent 调用，Antigravity ACP 不单列子 Agent 用量',
            modelStatus: 'unobserved',
            modelOmissionReason: 'Antigravity ACP PromptResponse 不上报实际应答模型',
            userAllowNotice: 'agy 用户级规则会自动放行：Bash(git status)'
          }
        })
      ]
    }
    const turnHtml = renderToStaticMarkup(
      <AssistantTurn turn={partialTurn} selectedId={null} onSelect={() => {}} />
    )
    expect(turnHtml).toContain('Antigravity')
    expect(turnHtml).not.toContain('Antigravity_acp')
    expect(turnHtml).toContain('部分用量')
    expect(turnHtml).toContain('模型未观测')
    expect(turnHtml).not.toContain('agy 用户级规则会自动放行')
    expect(turnHtml).not.toContain('Bash(git status)')

    const unavailableTurn: shared.Turn = {
      runId: 'run-agy-ui-2',
      userText: 'check2',
      done: true,
      items: [
        ev({
          id: 'agy-result-2',
          kind: 'harness',
          stage: 'result',
          providerId: 'antigravity',
          runtimeProvider: 'antigravity_acp',
          runtimeMetadata: {
            usageCoverage: 'unavailable',
            usageCoverageReason: 'Antigravity ACP PromptResponse 未返回 usage 字段',
            modelStatus: 'unobserved',
            modelOmissionReason: 'Antigravity ACP PromptResponse 不上报实际应答模型'
          }
        })
      ]
    }
    const unavailableHtml = renderToStaticMarkup(
      <AssistantTurn turn={unavailableTurn} selectedId={null} onSelect={() => {}} />
    )
    expect(unavailableHtml).toContain('用量不可用')
    expect(unavailableHtml).toContain('模型未观测')

    const toolHtml = renderToStaticMarkup(
      <ToolItem
        ev={partialTurn.items[0]}
        selected={false}
        onSelect={() => {}}
        maxDur={100}
        turnDone
      />
    )
    expect(toolHtml).toContain('由 hook 放行')
    expect(toolHtml).not.toContain('权限确认')

    // tool_result 上的 approvalSource=hook 合并到 tool_use 卡片时也必须保留
    const mergedHookTurn: shared.Turn = {
      runId: 'run-agy-ui-hook-merge',
      userText: 'run',
      done: true,
      items: [
        ev({ id: 'agy-t-u', kind: 'tool', stage: 'tool:run_command', tool: 'run_command', toolUseId: 'tc-h1', runtimeProvider: 'antigravity_acp' }),
        ev({
          id: 'agy-t-r',
          kind: 'tool',
          stage: 'tool_result',
          tool: 'run_command',
          toolUseId: 'tc-h1',
          runtimeProvider: 'antigravity_acp',
          runtimeMetadata: { approvalSource: 'hook', approvalLabel: '由 hook 放行' }
        })
      ]
    }
    const mergedHtml = renderToStaticMarkup(
      <AssistantTurn turn={mergedHookTurn} selectedId="agy-t-u" onSelect={() => {}} />
    )
    expect(mergedHtml).toContain('由 hook 放行')
    expect(mergedHtml).not.toContain('权限确认')
  })

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
    // Source filters re-scope one list, so they are a segmented group rather than tabs.
    expect(html).toContain('role="group" aria-label="Skill 来源"')
    expect(html).toContain('aria-pressed="true">全部</button>')
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