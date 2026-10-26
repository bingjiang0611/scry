import { describe, expect, it } from 'vitest'
import { parseRunControlPreferences } from './useIntegrations'

describe('运行控制偏好恢复', () => {
  it('恢复最后 Agent 及各 Provider 的模型、effort 和权限', () => {
    expect(parseRunControlPreferences(JSON.stringify({
      selectedAgentId: 'qoder',
      controlsByProvider: {
        qoder: {
          model: { id: 'ultimate' },
          effort: 'high',
          permissionMode: 'full_access'
        },
        codex: {
          model: { id: 'gpt-5.4', providerId: 'openai' },
          effort: 'medium',
          permissionMode: 'auto_review'
        }
      }
    }))).toEqual({
      selectedAgentId: 'qoder',
      controlsByProvider: {
        qoder: {
          model: { id: 'ultimate' },
          effort: 'high',
          permissionMode: 'full_access'
        },
        codex: {
          model: { id: 'gpt-5.4', providerId: 'openai' },
          effort: 'medium',
          permissionMode: 'auto_review'
        }
      }
    })
  })

  it('损坏或越界偏好回退默认审批，不恢复未知 Agent/Provider', () => {
    expect(parseRunControlPreferences('{broken')).toEqual({
      selectedAgentId: 'claude',
      controlsByProvider: {}
    })
    expect(parseRunControlPreferences(JSON.stringify({
      selectedAgentId: 'unknown-agent',
      controlsByProvider: {
        qoder: { model: { id: 42 }, effort: '', permissionMode: 'root' },
        unknown: { permissionMode: 'full_access' }
      }
    }))).toEqual({
      selectedAgentId: 'claude',
      controlsByProvider: {
        qoder: { permissionMode: 'default' }
      }
    })
  })
})
