import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HOST_RESTARTED_DETAIL, type RemoteIntentRouting } from './host-controller'
import { AUTHORIZED, CERT, MemoryLedgerStore, grantedController, routing } from './host-controller-fixtures'

describe('HostController intent execution (routing, workspaces, providers, projects)', () => {
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
    // A retry answers with the original intent: same run, same ledger position, so the
    // window can watch from where that intent sits instead of the session's first page.
    expect(retry).toEqual({ runId: first.runId, status: 'duplicate', seq: first.seq })
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

