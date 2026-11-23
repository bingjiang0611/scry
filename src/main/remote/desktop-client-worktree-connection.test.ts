import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { setup, ssh, statusRun, statusSnapshot } from './desktop-client-fixtures'

describe('DesktopRemoteClient managed worktree and receipt recovery', () => {
  it('sends only the managed-worktree selection and source project to the host intent', async () => {
    const fixture = await setup({ managedWorktrees: true, submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Managed worktree', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const workspace = { operationId: randomUUID(), intent: {
        kind: 'current' as const, repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64)
      } }
      await fixture.client.submit(pending.connection.id, {
        context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'managed', workspace
      })
      const request = fixture.tlsRequest.mock.calls.map(([value]) => value.request as { op?: string; detail?: string }).find(value => value.op === 'submit')
      expect(JSON.parse(request!.detail!)).toMatchObject({ cwd: '/workspace', workspace })
      expect(request!.detail).not.toContain('managed/worktree')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects managed-worktree submission in main when the active host did not negotiate it', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Legacy worktree host', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      await expect(fixture.client.submit(pending.connection.id, {
        context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'must not run',
        workspace: { operationId: randomUUID(), intent: { kind: 'current', repositoryId: 'a'.repeat(64), expectedRevision: 'b'.repeat(64) } }
      })).rejects.toThrow('workspace_selection_unavailable')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toEqual([])
      expect(fixture.tlsRequest.mock.calls.some(([value]) => (value.request as { op?: string }).op === 'submit')).toBe(false)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps a durable unknown receipt when the submit acknowledgement is malformed', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded' }) })
    try {
      const pending = await fixture.client.pair({ label: 'Malformed ack', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'malformed' })
      expect(receipt.status).toBe('unknown')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toMatchObject([{ intentId: receipt.intentId, status: 'unknown' }])
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps an absent host intent unknown instead of unlocking a resend', async () => {
    const fixture = await setup({ unknownIntent: true })
    try {
      const pending = await fixture.client.pair({ label: 'Absent intent', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      const receipt = await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'ambiguous' })
      const checked = await fixture.client.intentStatus(pending.connection.id, receipt.intentId)
      expect(checked).toMatchObject({ intentId: receipt.intentId, status: 'unknown' })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'resend' })).rejects.toThrow('unknown_receipts_pending')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('does not evict recorded runs merely to satisfy receipt capacity', async () => {
    const fixture = await setup({ submitResponse: () => ({ status: 'recorded', runId: randomUUID() }) })
    try {
      const pending = await fixture.client.pair({ label: 'Capacity', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      await fixture.client.connect(pending.connection.id)
      for (let index = 0; index < 256; index++) await fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: `run-${index}` })
      await expect(fixture.client.submit(pending.connection.id, { context: { cwd: '/workspace', providerId: 'claude' }, prompt: 'overflow' })).rejects.toThrow('intent_receipt_capacity_exceeded')
      await expect(fixture.client.intents(pending.connection.id)).resolves.toHaveLength(256)
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('keeps missing lifecycle evidence unknown and rejects malformed state or event pages', async () => {
    let response: unknown
    const parked = new Promise<never>(() => {})
    const fixture = await setup({ subscribeResponse: request => request.known ? parked : response })
    try {
      const pending = await fixture.client.pair({ label: 'Status', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const runId = randomUUID()
      for (const malformed of [null, {}, { subscribe: null }, { subscribe: { mode: 'snapshot' } }]) {
        response = malformed
        await expect(fixture.client.runStatus(id, runId)).rejects.toThrow('invalid_daemon_response')
      }
      response = statusSnapshot(fixture.host.hostId, { runs: [statusRun(runId, { lifecycle: 'running' })] })
      await expect(fixture.client.runStatus(id, runId)).rejects.toThrow('invalid_subscribe_run')
      response = statusSnapshot(fixture.host.hostId, { runs: [statusRun(runId, { lifecycle: 'settled' })] })
      await expect(fixture.client.runStatus(id, runId)).resolves.toMatchObject({ state: 'settled' })
      await fixture.client.disconnect(id)
      response = statusSnapshot(fixture.host.hostId)
      await fixture.client.connect(id)
      await expect(fixture.client.runStatus(id, runId)).resolves.toEqual({ state: 'unknown', changed: true })
      await expect(fixture.client.runStatus(id, runId)).resolves.toEqual({ state: 'unknown', changed: false })
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects invitations with a changed or malformed anchor', async () => {
    const fixture = await setup()
    try {
      const malformed = `scry-desktop1:${Buffer.from(JSON.stringify({ version: 1, hostId: fixture.host.hostId, anchorPEM: 'not pem', pairPort: 1, runPort: 2, pairingId: randomUUID(), secret: 'secret', expiresAt: Date.now() + 1000 })).toString('base64url')}`
      await expect(fixture.client.pair({ label: 'bad', ssh, invitation: malformed })).rejects.toThrow('invalid_certificate')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('projects host workspaceProgress onto runStatus and follows the completed step after admission', async () => {
    const runId = randomUUID()
    const operationId = randomUUID()
    const progress = {
      operationId,
      repositoryId: 'a'.repeat(64),
      stage: 'checking_out',
      workspacePrepared: true,
      checkout: { completed: 32, total: 64, percent: 50 },
      cancellable: true,
      details: ['工作区元数据已创建'],
      branch: 'scry/remote-1',
      baseRef: 'main',
      updatedAt: 1234
    }
    // v3: the host projects its run_progress marker onto the run row, and sends the next
    // step (admission marks it completed) as a run hint on the status subscription.
    let releaseAdmitted!: () => void
    const admitted = new Promise<void>(resolve => { releaseAdmitted = resolve })
    let follows = 0
    const fixture = await setup({
      managedWorktrees: true,
      subscribeResponse: request => {
        if (!request.known) return statusSnapshot(fixture.host.hostId, { runs: [statusRun(runId, { workspaceProgress: progress })] })
        if (follows++ > 0) return new Promise<never>(() => {})
        return admitted.then(() => ({ subscribe: { mode: 'events', hostId: fixture.host.hostId, logId: 'fixture-log', seq: 2, events: [],
          hints: [{ kind: 'run', runId, outputSeq: 0, workspaceProgress: { ...progress, stage: 'completed', cancellable: false } }] } }))
      }
    })
    try {
      const pending = await fixture.client.pair({ label: 'Progress', ssh, invitation: fixture.invitation })
      const id = pending.connection.id
      await fixture.client.finishPairing(id)
      await fixture.client.connect(id)
      const mid = await fixture.client.runStatus(id, runId)
      expect(mid.workspaceProgress).toMatchObject({
        operationId,
        stage: 'checking_out',
        workspacePrepared: true,
        checkout: { completed: 32, total: 64, percent: 50 },
        cancellable: true
      })
      releaseAdmitted()
      await vi.waitFor(async () => {
        expect((await fixture.client.runStatus(id, runId)).workspaceProgress).toMatchObject({ stage: 'completed', cancellable: false })
      })
      const operations = fixture.tlsRequest.mock.calls.map(call => (call[0].request as { op?: string }).op)
      expect(operations).not.toContain('watch')
    } finally { await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})
