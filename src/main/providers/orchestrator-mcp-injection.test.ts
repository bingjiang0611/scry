import { describe, expect, it, vi } from 'vitest'
import { ProviderRegistry } from './registry'
import type { ProviderAdapter } from './types'
import { ORCHESTRATOR_AUTO_ALLOW_TOOL_NAMES } from './orchestrator-mcp-sdk'
import { qoderCanUseTool } from './qoder-run-permissions'

describe('P6-2 provider orchestrationTools capability gate & exact-name tool allowlist', () => {
  it('rejects orchestrationTools on adapters that do not declare orchestrationTools: true', () => {
    const adapter: ProviderAdapter = {
      id: 'opencode',
      runtimeProvider: 'opencode_server',
      describe: async () => ({
        id: 'opencode', label: 'OpenCode', runtimeProvider: 'opencode_server', transport: 'test',
        available: true, capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
        health: { state: 'ready', transport: 'test' }
      }),
      run: vi.fn()
    }
    const registry = new ProviderRegistry([adapter])
    expect(() =>
      registry.run('opencode', {
        runId: 'r1',
        prompt: 'hi',
        cwd: '/tmp',
        attachments: [],
        emit: () => {},
        orchestrationTools: { kind: 'in_process', callTool: async () => ({ ok: true }) }
      })
    ).toThrow(/编排工具/)
    expect(adapter.run).not.toHaveBeenCalled()
  })

  it('auto-allows only the 5 exact mcp__scry_orchestrator__<tool> names in qoderCanUseTool and still prompts for lookalikes', async () => {
    expect([...ORCHESTRATOR_AUTO_ALLOW_TOOL_NAMES].sort()).toEqual([
      'mcp__scry_orchestrator__scry_capabilities',
      'mcp__scry_orchestrator__scry_task_cancel',
      'mcp__scry_orchestrator__scry_task_delegate',
      'mcp__scry_orchestrator__scry_task_result_read',
      'mcp__scry_orchestrator__scry_task_status'
    ])

    const requestUserInput = vi.fn(async () => ({
      runId: 'r1', questionId: 'q1', behavior: 'answered' as const, answers: {}
    }))
    const canUse = qoderCanUseTool(
      { runId: 'r1', prompt: 'hi', cwd: '/tmp', attachments: [], permissionMode: 'default', emit: () => {}, requestUserInput },
      (action) => action()
    )

    // Exact orchestration tool -> auto-allowed without prompting user
    const allowed = await canUse('mcp__scry_orchestrator__scry_capabilities', {}, {
      signal: new AbortController().signal, toolUseID: 'tu-1'
    })
    expect(allowed.behavior).toBe('allow')
    expect(requestUserInput).not.toHaveBeenCalled()

    // Unknown tool with same prefix -> NOT auto-allowed, prompts user!
    await canUse('mcp__scry_orchestrator__evil_tool', {}, {
      signal: new AbortController().signal, toolUseID: 'tu-2'
    })
    expect(requestUserInput).toHaveBeenCalledTimes(1)
  })
})
