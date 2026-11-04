import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HOST_RESTARTED_DETAIL, HostController, type HostControllerDependencies, type RemoteIntentRouting } from './host-controller'
import type { IssuedPairingCertificate, PairingDependencies, PairingPersistence, PairingState } from './pairing'
import type { LedgerEvent, LedgerStore } from './session-ledger'
import type { WorkspaceAuthorizer } from './remote-run-policy'

const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)
const AUTHORIZED = '/authorized/project'

class MemoryPairingStore implements PairingPersistence {
  value: PairingState | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void { this.value = structuredClone(state) }
}
class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[] = []
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}

const workspace: WorkspaceAuthorizer = {
  authorize(cwd) { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd }
}

function pairingDeps(): PairingDependencies {
  const time = { wall: 1_000_000, monotonic: 0 }
  const issue = vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
    deviceId, certificatePEM: 'synthetic certificate, not cryptographic evidence', certificateSHA256: CERT,
    publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
  }))
  return {
    store: new MemoryPairingStore(), hostId: randomUUID(), anchorSHA256: ANCHOR,
    clock: () => time.wall, monotonic: () => time.monotonic,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })), issue
  }
}

type RunProvider = (input: { runId: string; routing: RemoteIntentRouting; progress(detail?: string): void }) => Promise<void>

async function grantedController(runProvider: RunProvider, listProjects?: () => { path: string; label: string }[],
  extra: Partial<HostControllerDependencies> = {}) {
  const controller = new HostController({
    pairing: pairingDeps(), ledgerStore: new MemoryLedgerStore(), workspace, runProvider,
    ...(listProjects ? { listProjects } : {}),
    ...extra
  })
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  const grant = await controller.authority.confirmLocal(pair.pairingId, KEY)
  return { controller, deviceId: grant.deviceId }
}

const routing = (over: Partial<RemoteIntentRouting> = {}): string =>
  JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

describe('HostController (composition root)', () => {
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
    const { controller } = await grantedController(vi.fn(async () => {}))
    await expect(controller.readToolPanel(CERT, { kind: 'llmPerformance' })).rejects.toThrow('tool_panel_unavailable')
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

  it('runs a routed intent end-to-end through the real modules and reflects settlement', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting; progress(d?: string): void }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)

    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'ship it' }) })
    expect(submit.status).toBe('recorded')
    await controller.idle()

    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'ship it' }])
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('settled')
    const feed = controller.poll(CERT, { cursor: 0 })
    expect(feed.events.map((e) => e.kind)).toEqual(['intent_recorded', 'run_dispatched', 'run_settled'])
  })

  it('on restart closes runs orphaned mid-execution as failed with an honest reason and never re-runs them', async () => {
    const ledgerStore = new MemoryLedgerStore()
    const orphan = randomUUID()
    const recorded = randomUUID()
    ledgerStore.log = [
      { seq: 1, at: 1, runId: orphan, kind: 'intent_recorded', intentId: randomUUID(), detail: routing({ prompt: 'was running' }) },
      { seq: 2, at: 2, runId: orphan, kind: 'run_dispatched' },
      { seq: 3, at: 3, runId: orphan, kind: 'run_progress', detail: JSON.stringify({ event: 'question_opened' }) },
      { seq: 4, at: 4, runId: recorded, kind: 'intent_recorded', intentId: randomUUID(), detail: routing({ prompt: 'never dispatched' }) }
    ]
    const runProvider = vi.fn(async (_input: { routing: RemoteIntentRouting }) => {})
    const { controller } = await grantedController(runProvider, undefined, { ledgerStore })
    controller.recover()
    await controller.idle()

    expect(controller.runState(CERT, { runId: orphan })).toBe('failed')
    const failed = ledgerStore.log.find((event) => event.runId === orphan && event.kind === 'run_failed')
    expect(failed?.detail).toBe(HOST_RESTARTED_DETAIL)
    expect(runProvider.mock.calls.map(([input]) => input.routing.prompt)).toEqual(['never dispatched'])
    expect(controller.runState(CERT, { runId: recorded })).toBe('settled')
  })

  it('accepts bounded explicit run controls and rejects invalid permission modes', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({
      prompt: 'go', modelId: 'gpt-5.4', modelProviderId: 'openai', effort: 'high', permissionMode: 'full_access'
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0]).toMatchObject({ modelId: 'gpt-5.4', modelProviderId: 'openai', effort: 'high', permissionMode: 'full_access' })

    const rejected = controller.submitIntent(CERT, { intentId: randomUUID(), detail: JSON.stringify({
      cwd: AUTHORIZED, providerId: 'claude', prompt: 'go', permissionMode: 'invented'
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: rejected.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('accepts only structurally valid managed-worktree selections in the durable intent detail', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const workspace = { operationId: '11111111-1111-4111-8111-111111111111', intent: {
      kind: 'current' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64)
    } }
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go', workspace }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0]?.workspace).toEqual(workspace)
    const rejected = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({
      prompt: 'go', workspace: { ...workspace, operationId: '../escape' } as unknown as RemoteIntentRouting['workspace']
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: rejected.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('accepts bounded encrypted image/text attachments and rejects malformed payloads before Provider execution', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const image = { kind: 'image' as const, name: 'screen.jpg', mimeType: 'image/jpeg', dataBase64: '/9j/', size: 3 }
    const text = { kind: 'text' as const, name: 'error.log', mimeType: 'text/plain', dataBase64: 'Ym9vbQ==', size: 4 }
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'inspect', attachments: [image, text] }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0].attachments).toEqual([image, text])

    const fourKiB = Buffer.alloc(4 * 1024, 0x61)
    const realSizedText = {
      kind: 'text' as const,
      name: 'context.txt',
      mimeType: 'text/plain',
      dataBase64: fourKiB.toString('base64'),
      size: fourKiB.length
    }
    const realSized = controller.submitIntent(CERT, {
      intentId: randomUUID(),
      detail: routing({ prompt: 'inspect context', attachments: [realSizedText] })
    })
    await controller.idle()
    expect(controller.runState(CERT, { runId: realSized.runId })).toBe('settled')
    expect(seen[1].attachments).toEqual([realSizedText])

    const malformed = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ attachments: [{ ...image, size: 99 }] }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: malformed.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(2)
  })

  it('records the intent but fails the run for an unauthorized workspace (never reaching the provider)', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider)
    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: '/tmp/smuggled' }) })
    await controller.idle()
    expect(runProvider).not.toHaveBeenCalled()
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('failed')
    const failed = controller.poll(CERT, { cursor: 0 }).events.find((e) => e.kind === 'run_failed')
    expect(failed?.detail).toContain('workspace_not_authorized')
  })

  it('fails the run truthfully when the provider throws', async () => {
    const runProvider = vi.fn(async () => { throw new Error('provider exploded') })
    const { controller } = await grantedController(runProvider)
    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })
    await controller.idle()
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('failed')
  })

  it('is idempotent on intentId: a retry does not re-run the provider', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider)
    const intentId = randomUUID()
    const first = controller.submitIntent(CERT, { intentId, detail: routing() })
    await controller.idle()
    const retry = controller.submitIntent(CERT, { intentId, detail: routing() })
    await controller.idle()
    expect(retry).toEqual({ runId: first.runId, status: 'duplicate' })
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('exposes host-authorized projects only to the granted device (delegates to the gateway)', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider, () => [{ path: AUTHORIZED, label: 'project' }])
    expect(controller.listProjects(CERT)).toEqual([{ path: AUTHORIZED, label: 'project' }])
    expect(() => controller.listProjects('f'.repeat(64))).toThrowError(/device_not_authorized/)
    await controller.authority.revoke(deviceId)
    expect(() => controller.listProjects(CERT)).toThrowError(/device_not_authorized/)
  })

  it('returns an honest empty project list when no source is injected', async () => {
    const { controller } = await grantedController(vi.fn(async () => {}))
    expect(controller.listProjects(CERT)).toEqual([])
  })

  it('denies a stranger certificate and a revoked device', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider)
    expect(() => controller.submitIntent('f'.repeat(64), { intentId: randomUUID(), detail: routing() })).toThrowError(/device_not_authorized/)
    await controller.authority.revoke(deviceId)
    expect(() => controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })).toThrowError(/device_not_authorized/)
    expect(runProvider).not.toHaveBeenCalled()
  })
})
