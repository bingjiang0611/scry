import { describe, expect, it } from 'vitest'
import { permissionOptions, unsupportedPermissionMode } from './run-controls'
import { AGENT_PERMISSION_MODES, isAgentPermissionMode } from '../../shared/runtime'
import { openCodePermissionRules } from './opencode'
import { codexAccess } from './codex'

describe('审批档位', () => {
  it('四档语义存在且默认档位仍是 default', () => {
    expect(AGENT_PERMISSION_MODES).toEqual(['default', 'auto_accept_edits', 'auto_review', 'full_access'])
    expect(isAgentPermissionMode('auto_accept_edits')).toBe(true)
    expect(isAgentPermissionMode('full-access')).toBe(false)
    expect(isAgentPermissionMode(undefined)).toBe(false)
    // 借鉴 T3 时明确不抄的一点：默认不得是最宽权限
    expect(AGENT_PERMISSION_MODES[0]).toBe('default')
  })

  it('只列出 Provider 真正支持的档位', () => {
    expect(permissionOptions().map((option) => option.id)).toEqual(['default', 'full_access'])
    expect(permissionOptions({ autoReview: true }).map((option) => option.id))
      .toEqual(['default', 'auto_review', 'full_access'])
    expect(permissionOptions({ autoAcceptEdits: true, autoReview: true }).map((option) => option.id))
      .toEqual(['default', 'auto_accept_edits', 'auto_review', 'full_access'])
    expect(permissionOptions({ autoAcceptEdits: true }).find((option) => option.id === 'auto_accept_edits'))
      .toMatchObject({ label: '自动接受编辑', description: expect.stringContaining('仍然请求确认') })
  })

  it('不支持时给出显式错误，而不是静默降档', () => {
    expect(() => { throw unsupportedPermissionMode('Codex', '自动接受编辑', '没有独立档位') })
      .toThrow('Codex 不支持“自动接受编辑”权限模式：没有独立档位')
    expect(() => openCodePermissionRules('auto_accept_edits')).toThrow('OpenCode 不支持“自动接受编辑”权限模式')
    expect(() => codexAccess('auto_accept_edits')).toThrow('Codex 不支持“自动接受编辑”权限模式')
    // Codex 支持的两档仍按原生语义映射，没有被这次改动动过
    expect(codexAccess('default')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' })
    expect(codexAccess('auto_review')).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' })
    expect(codexAccess('full_access')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(() => openCodePermissionRules('auto_review')).toThrow('OpenCode 不支持自动审查权限模式')
    // 支持的档位仍按原语义返回
    expect(openCodePermissionRules('full_access')).toEqual([{ permission: '*', pattern: '*', action: 'allow' }])
    expect(openCodePermissionRules('default')).toEqual([{ permission: '*', pattern: '*', action: 'ask' }])
  })
})
