import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { ConversationStore } from '../main/conversation-store'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun as waitRunTerminal } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)


async function withSmokeEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.argv.push('--remote-debugging-port=0')
  try {
    return await fn()
  } finally {
    process.argv.length = saved.argvLen
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
  }
}

async function sendConversationTurn(
  host: Awaited<ReturnType<typeof createDaemonHostProcess>>,
  device: Awaited<ReturnType<typeof enrollLocal>>,
  conversationId: string,
  prompt: string,
  confirmFresh: boolean
): Promise<{ ledgerRunId: string; canonicalRunId: string; state: string }> {
  const preview = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
    op: 'conversation',
    method: 'preview',
    args: [conversationId, { providerId: 'codex' }]
  })
  const sent = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
    op: 'conversation',
    method: 'send',
    args: [
      {
        providerId: 'codex',
        conversationId,
        expectedRevision: preview.result.revision,
        expectedContinuationKey: preview.result.target.continuationKey,
        commandId: randomUUID(),
        prompt,
        selectedItems: [],
        confirmFresh
      }
    ]
  })
  expect(sent.error).toBeUndefined()
  const ledgerRunId = sent.result.ledger.runId as string
  const canonicalRunId = sent.result.runId as string
  const state = await waitRunTerminal(
    host.channel.socketPath,
    host.service.caCertificatePEM,
    device.certPEM,
    device.keyPEM,
    ledgerRunId
  )
  return { ledgerRunId, canonicalRunId, state }
}

describe('P4-1 B1: legacy sync import and deferred backfill resolve true H3 ordinals', () => {
  it('sync-imports pre-fix adopted conversation turn at true H3 ordinal=3 (not shadow MAX+1=1)', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-adopted-import')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const seedStore = new ConversationStore(userDataDir)
    const adopted = await seedStore.create(canonicalWs, {
      target: { providerId: 'codex', continuationKey: 'codex:default' },
      nativeSessionId: 'native-adopted-imp',
      turns: [
        { runId: 'imp-1', items: [], nativeItems: [] },
        { runId: 'imp-2', items: [], nativeItems: [] }
      ]
    })
    const turn3RunId = randomUUID()
    const begun = await seedStore.begin(adopted.id, {
      runId: turn3RunId,
      commandId: randomUUID(),
      payloadHash: 'a'.repeat(64),
      expectedRevision: adopted.revision,
      target: { providerId: 'codex', continuationKey: 'codex:default' },
      items: [],
      selectedItems: []
    })
    expect(begun.turn.ordinal).toBe(3)
    await seedStore.settle(
      adopted.id,
      turn3RunId,
      { status: 'accepted', nativeSessionId: 'native-adopted-imp', outcome: 'completed', nativeItems: [] },
      []
    )

    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const ledgerRunId = randomUUID()
    const t0 = 1_700_000_000_000
    writeFileSync(
      join(ledgerDir, 'session-ledger.log'),
      [
        JSON.stringify({
          seq: 1,
          at: t0,
          runId: ledgerRunId,
          kind: 'intent_recorded',
          intentId: randomUUID(),
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: canonicalWs,
            prompt: 'legacy adopted turn 3',
            conversation: { conversationId: adopted.id, runId: turn3RunId }
          })
        }),
        JSON.stringify({ seq: 2, at: t0 + 1, runId: ledgerRunId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: 3, at: t0 + 2, runId: ledgerRunId, kind: 'run_settled' })
      ].join('\n') + '\n',
      { mode: 0o600 }
    )

    await withSmokeEnv(async () => {
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      try {
        const authority = host.orchestrationAuthority!
        expect(authority.sink.getTurn(adopted.id, 1)).toBeUndefined()
        expect(authority.sink.getTurn(adopted.id, 3)?.runId).toBe(turn3RunId)
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })
  })

  it('interleaves live turn 4 with deferred backfill of pre-fix turns 1-3 without colliding on live turn 5', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-interleaved-backfill')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const seedStore = new ConversationStore(userDataDir)
    let conv = await seedStore.create(canonicalWs)
    const oldRunIds: string[] = []
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const rId = randomUUID()
      oldRunIds.push(rId)
      const begun = await seedStore.begin(conv.id, {
        runId: rId,
        commandId: randomUUID(),
        payloadHash: String(ordinal).repeat(64).slice(0, 64),
        expectedRevision: conv.revision,
        target: { providerId: 'codex', continuationKey: 'codex:default' },
        items: [],
        selectedItems: []
      })
      expect(begun.turn.ordinal).toBe(ordinal)
      conv = await seedStore.settle(
        conv.id,
        rId,
        { status: 'accepted', nativeSessionId: 'native-interleave-1', outcome: 'completed', nativeItems: [] },
        []
      )
    }

    const ledgerDir = join(userDataDir, 'remote', 'ledger')
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const t0 = 1_700_000_000_000
    const lines: string[] = []
    let seq = 0
    for (let i = 0; i < 2_050; i += 1) {
      const fillerId = randomUUID()
      lines.push(
        JSON.stringify({
          seq: ++seq,
          at: t0 + i * 10,
          runId: fillerId,
          kind: 'intent_recorded',
          intentId: randomUUID(),
          detail: JSON.stringify({ providerId: 'codex', cwd: canonicalWs, prompt: `filler ${i}` })
        }),
        JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 1, runId: fillerId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: t0 + i * 10 + 2, runId: fillerId, kind: 'run_settled' })
      )
    }
    for (let i = 0; i < oldRunIds.length; i += 1) {
      const ledgerRunId = randomUUID()
      lines.push(
        JSON.stringify({
          seq: ++seq,
          at: t0 + 30_000 + i * 10,
          runId: ledgerRunId,
          kind: 'intent_recorded',
          intentId: randomUUID(),
          detail: JSON.stringify({
            providerId: 'codex',
            cwd: canonicalWs,
            prompt: `legacy turn ${i + 1}`,
            conversation: { conversationId: conv.id, runId: oldRunIds[i] }
          })
        }),
        JSON.stringify({ seq: ++seq, at: t0 + 30_000 + i * 10 + 1, runId: ledgerRunId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: t0 + 30_000 + i * 10 + 2, runId: ledgerRunId, kind: 'run_settled' })
      )
    }
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${lines.join('\n')}\n`, { mode: 0o600 })

    await withSmokeEnv(async () => {
      let releaseBackfill: (() => void) | undefined
      const pauseBackfill = new Promise<void>((resolve) => {
        releaseBackfill = resolve
      })
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        orchestrationPauseBackfill: pauseBackfill,
        log: () => undefined
      })
      try {
        const authority = host.orchestrationAuthority!
        const device = await enrollLocal(host.service)

        // Live turn 4 commits and settles BEFORE deferred backfill runs (deterministically paused)
        const turn4 = await sendConversationTurn(host, device, conv.id, 'live turn 4 during backfill', true)
        expect(turn4.state).toBe('settled')
        expect(authority.sink.getTurn(conv.id, 1)).toBeUndefined()
        expect(authority.sink.getTurn(conv.id, 4)?.runId).toBe(turn4.canonicalRunId)

        // Release deferred backfill while turn 4 already occupies ordinal 4
        releaseBackfill?.()
        await authority.importComplete

        // S1: historical backfill MUST NOT overwrite live turn 4 as session.lastRunId
        expect(authority.sink.getSession(conv.id)?.lastRunId).toBe(turn4.canonicalRunId)

        // Live turn 5 MUST NOT collide with deferred backfill or fence
        const turn5 = await sendConversationTurn(host, device, conv.id, 'live turn 5 after backfill', false)
        expect(turn5.state).toBe('settled')

        expect(authority.sink.isWriteIndeterminate()).toBe(false)
        expect(authority.sink.getTurn(conv.id, 1)?.runId).toBe(oldRunIds[0])
        expect(authority.sink.getTurn(conv.id, 2)?.runId).toBe(oldRunIds[1])
        expect(authority.sink.getTurn(conv.id, 3)?.runId).toBe(oldRunIds[2])
        expect(authority.sink.getTurn(conv.id, 4)?.runId).toBe(turn4.canonicalRunId)
        expect(authority.sink.getTurn(conv.id, 5)?.runId).toBe(turn5.canonicalRunId)
        expect(authority.sink.getSession(conv.id)?.lastRunId).toBe(turn5.canonicalRunId)
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        releaseBackfill?.()
        await host.dispose()
      }
    })
  })
})
