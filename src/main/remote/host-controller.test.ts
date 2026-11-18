import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AUTHORIZED, CERT, MemoryLedgerStore, grantedController, routing } from './host-controller-fixtures'

describe('HostController (composition root)', () => {
  it('never reaches the Provider when recovering a crash between fencing an intent and cancelling it', async () => {
    const ledgerStore = new MemoryLedgerStore()
    const runId = randomUUID()
    const intentId = randomUUID()
    // First half of explicit recovery was fsynced, but cancellation was not.
    // This reserved id has no routing payload, including after a host restart.
    ledgerStore.log = [{ seq: 1, at: 1, runId, intentId, kind: 'intent_recorded' }]
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider, undefined, { ledgerStore })
    controller.recover()
    await controller.idle()
    expect(controller.runState(CERT, { runId })).toBe('failed')
    expect(ledgerStore.log.at(-1)).toMatchObject({ kind: 'run_failed', runId, detail: 'invalid_target' })
    expect(runProvider).not.toHaveBeenCalled()
  })

  it('only grants an explicitly selected desktop directory to an authorized owner, without starting a run', async () => {
    const known = new Set([AUTHORIZED])
    const project = { path: '/new/project', label: 'project' }
    const list = vi.fn(() => ({ current: project, directories: [], cursor: 0, total: 0, hasMore: false, snapshot: 'a'.repeat(64) }))
    const select = vi.fn((path: string) => { known.add(path); return project })
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider, undefined, {
      workspace: { authorize: (path) => { if (!known.has(path)) throw new Error('not authorized'); return path } },
      desktopDirectories: { list, select },
      readDesktop: async () => ({ kind: 'info', protocol: 1, hostId: 'test', execution: 'canonical' })
    })
    expect(() => controller.desktopDirectory('0'.repeat(64), { action: 'select', path: project.path })).toThrow('device_not_authorized')
    expect(list).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(controller.desktopDirectory(CERT, { action: 'list', path: project.path }).action).toBe('list')
    expect(select).not.toHaveBeenCalled()
    expect(known.has(project.path)).toBe(false)
    await expect(controller.readDesktop(CERT, { kind: 'info' })).resolves.toMatchObject({ directorySelection: true })
    const denied = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: project.path, prompt: 'not yet authorized' }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: denied.runId })).toBe('failed')
    expect(runProvider).not.toHaveBeenCalled()
    expect(controller.desktopDirectory(CERT, { action: 'select', path: project.path })).toEqual({ action: 'select', project })
    expect(select).toHaveBeenCalledExactlyOnceWith(project.path)
    expect(runProvider).not.toHaveBeenCalled()
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: project.path, prompt: 'explicit send' }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(runProvider).toHaveBeenCalledTimes(1)
    await controller.authority.revoke(deviceId)
    expect(() => controller.desktopDirectory(CERT, { action: 'list' })).toThrow('device_not_authorized')
    expect(() => controller.desktopDirectory(CERT, { action: 'select', path: '/other' })).toThrow('device_not_authorized')
    expect(list).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('serves read-only tool panels but rejects unknown kinds, bad ranges and unpaired devices', async () => {
    const analytics = vi.fn(() => ({
      status: 'ready' as const, rangeDays: 7 as const, fromDay: '2026-10-15', toDay: '2026-10-21', observedAt: 1, days: [],
      totals: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
        costUsd: null, turns: 0, usageRows: 0, inputKnownRows: 0, outputKnownRows: 0, cacheReadKnownRows: 0, cacheWriteKnownRows: 0,
        reasoningKnownRows: 0, tokenKnownRows: 0, costKnownRows: 0, exactCostRows: 0, providerReportedCostRows: 0, estimatedCostRows: 0, inferredCostRows: 0 },
      byDay: [], dailyByProvider: [], byProvider: [], byModel: []
    }))
    const mcpTrust = vi.fn(async () => ({ snapshot: { configured: [], runtime: null }, scan: {
      summary: { critical: 1, high: 0, medium: 0, low: 0, info: 0, status: 'block' },
      findings: [{ findingInstanceId: 'f1', title: '未固定版本的 MCP 包', severity: 'critical', confidence: 'high',
        policy: { decision: 'block' }, rule: { id: 'mcpguard/unpinned-package', version: '1' },
        affectedTargets: [{ targetId: 't1', role: 'subject' }], recommendation: '固定版本',
        evidence: [{ path: '/secret/path', keyName: 'TOKEN' }] }]
    } }))
    const { controller } = await grantedController(vi.fn(async () => {}), undefined, {
      toolPanels: { analytics, llmPerformance: () => [{ rows: [], invalidLines: 0, truncated: false }, { observedAt: 'now', sessions: [] }], mcpTrust }
    })
    await expect(controller.readToolPanel('0'.repeat(64), { kind: 'analytics', rangeDays: 7 })).rejects.toThrow('device_not_authorized')
    expect(analytics).not.toHaveBeenCalled()
    await expect(controller.readToolPanel(CERT, { kind: 'secrets' })).rejects.toThrow('invalid_tool_panel')
    await expect(controller.readToolPanel(CERT, { kind: 'analytics', rangeDays: 14 })).rejects.toThrow('invalid_tool_panel')
    await expect(controller.readToolPanel(CERT, { kind: 'mcpTrust', providerId: '' })).rejects.toThrow('invalid_tool_panel')
    expect(mcpTrust).not.toHaveBeenCalled()

    const panel = await controller.readToolPanel(CERT, { kind: 'analytics', rangeDays: 30 })
    expect(panel.kind).toBe('analytics')
    expect(panel.analytics?.rangeDays).toBe(7)
    // The panel is a background read: a device can never ask for a refresh.
    const mcp = await controller.readToolPanel(CERT, { kind: 'mcpTrust', providerId: 'claude', cwd: '/etc' })
    expect(mcp.kind).toBe('mcpTrust')
    // The device names a Provider only; a device-supplied path is ignored.
    expect(mcpTrust).toHaveBeenCalledExactlyOnceWith({ providerId: 'claude' })
    expect(mcp.mcp?.scan?.status).toBe('block')
    expect(mcp.mcp?.scan?.findings[0]).toMatchObject({ severity: 'critical', decision: 'block', targets: ['t1'] })
    // Evidence paths and key names stay on the Mac.
    expect(JSON.stringify(mcp)).not.toContain('/secret/path')
    expect(JSON.stringify(mcp)).not.toContain('TOKEN')
  })

  it('reports an unavailable panel instead of an empty one when the host has no source', async () => {
    // A host that cannot read the panel (the daemon, until analytics lands there) must
    // say so. Every kind carries the reason and none of them carries empty data, so a
    // device renders "no capability" instead of "no data".
    const { controller } = await grantedController(vi.fn(async () => {}))
    for (const input of [{ kind: 'analytics' }, { kind: 'llmPerformance' }, { kind: 'mcpTrust', providerId: 'claude' }]) {
      const payload = await controller.readToolPanel(CERT, input)
      expect(payload.kind).toBe(input.kind)
      expect(payload.unavailable).toMatch(/未提供/)
      expect(payload.analytics).toBeUndefined()
      expect(payload.llm).toBeUndefined()
      expect(payload.mcp).toBeUndefined()
    }
  })

  it('authorizes session metadata actions, canonicalizes cwd, and never dispatches denied requests', async () => {
    const sessionAction = vi.fn(async () => true)
    const { controller } = await grantedController(vi.fn(async () => {}), undefined, {
      workspace: { authorize: (path) => { if (path === '/alias') return AUTHORIZED; if (path === AUTHORIZED) return AUTHORIZED; throw new Error('not authorized') } },
      sessionAction
    })
    const context = { cwd: '/alias', providerId: 'claude', externalSessionId: 'session-1' }
    await expect(controller.sessionAction('0'.repeat(64), { context, action: { kind: 'pin', pinned: true } })).rejects.toThrow('device_not_authorized')
    expect(sessionAction).not.toHaveBeenCalled()
    await expect(controller.sessionAction(CERT, { context: { ...context, cwd: '/other' }, action: { kind: 'pin', pinned: true } })).rejects.toThrow('not authorized')
    expect(sessionAction).not.toHaveBeenCalled()
    await expect(controller.sessionAction(CERT, { context, action: { kind: 'pin', pinned: true } })).resolves.toBe(true)
    expect(sessionAction).toHaveBeenCalledExactlyOnceWith({ cwd: AUTHORIZED, providerId: 'claude', externalSessionId: 'session-1' }, { kind: 'pin', pinned: true }, expect.any(Function))
  })

  it.each(['device', 'workspace'] as const)('rejects %s revocation during metadata recovery before the write', async (revoked) => {
    let release!: () => void
    const recovery = new Promise<void>(resolve => { release = resolve })
    let authorized = true
    const write = vi.fn()
    const { controller, deviceId } = await grantedController(vi.fn(async () => {}), undefined, {
      workspace: { authorize: (path) => { if (!authorized) throw new Error('not authorized'); return path } },
      sessionAction: async (_context, _action, authorize) => {
        await recovery
        authorize()
        write()
        return true
      }
    })
    const result = controller.sessionAction(CERT, { context: { cwd: AUTHORIZED, providerId: 'pi', externalSessionId: 'session' }, action: { kind: 'archive', archived: true } })
    const denied = expect(result).rejects.toThrow(revoked === 'device' ? 'device_not_authorized' : 'not authorized')
    if (revoked === 'device') await controller.authority.revoke(deviceId)
    else authorized = false
    release()
    await denied
    expect(write).not.toHaveBeenCalled()
  })
})
