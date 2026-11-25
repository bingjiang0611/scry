import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, realpathSync } from 'node:fs'
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

describe('P4-1 B1: true turn ordinal from H3 conversation ledger across adopted, forked, and restarted sessions', () => {
  it('uses H3 ordinal=3 for adopted conversation with 2 imported prior turns (never shadow MAX+1=1)', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-adopted')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const seedStore = new ConversationStore(userDataDir)
    const adopted = await seedStore.create(canonicalWs, {
      target: { providerId: 'codex', continuationKey: 'codex:default' },
      nativeSessionId: 'native-adopted-1',
      retiredReason: 'adopted_test',
      turns: [
        { runId: 'imported-run-1', items: [], nativeItems: [] },
        { runId: 'imported-run-2', items: [], nativeItems: [] }
      ]
    })
    expect(adopted.turns.map((t) => t.ordinal)).toEqual([1, 2])

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
        const device = await enrollLocal(host.service)
        const sent = await sendConversationTurn(host, device, adopted.id, 'third turn after adoption', true)
        expect(sent.state).toBe('settled')

        const authority = host.orchestrationAuthority!
        // The projection must use the conversation’s original ordinal.
        expect(authority.sink.getTurn(adopted.id, 1)).toBeUndefined()
        const turn3 = authority.sink.getTurn(adopted.id, 3)
        expect(turn3?.runId).toBe(sent.canonicalRunId)
        expect(turn3?.delivery).toBe('accepted')
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })
  })

  it('uses H3 ordinal=3 for forked conversation with 2 prefix turns', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-forked')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    let forkedId = ''
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
        const device = await enrollLocal(host.service)
        const created = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'conversation',
          method: 'create',
          args: [canonicalWs]
        })
        const sourceId = (created.result as { id: string }).id
        expect((await sendConversationTurn(host, device, sourceId, 'source turn 1', true)).state).toBe('settled')
        const turn2 = await sendConversationTurn(host, device, sourceId, 'source turn 2', false)
        expect(turn2.state).toBe('settled')

        const store = new ConversationStore(userDataDir)
        const source = (await store.read(sourceId))!
        const begunFork = await store.beginFork(source.id, {
          commandId: randomUUID(),
          intentHash: 'a'.repeat(64),
          expectedRevision: source.revision,
          sourceRunId: turn2.canonicalRunId
        })
        const forked = await store.finishFork(begunFork.conversation.id, {
          status: 'accepted',
          nativeSessionId: 'native-fork-1'
        })
        expect(forked.turns.map((t) => t.ordinal)).toEqual([1, 2])
        forkedId = forked.id
      } finally {
        await host.dispose()
      }
    })

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
        const device = await enrollLocal(host.service)
        const sent = await sendConversationTurn(host, device, forkedId, 'first dispatched turn on fork', true)
        expect(sent.state).toBe('settled')

        const authority = host.orchestrationAuthority!
        expect(authority.sink.getTurn(forkedId, 1)).toBeUndefined()
        const turn3 = authority.sink.getTurn(forkedId, 3)
        expect(turn3?.runId).toBe(sent.canonicalRunId)
        expect(turn3?.delivery).toBe('accepted')
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })
  })

  it('retains ordinals 3 and 4 across subsequent daemon restarts', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-preshadow-restart')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    let convId = ''
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
        const device = await enrollLocal(host.service)
        const created = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'conversation',
          method: 'create',
          args: [canonicalWs]
        })
        convId = (created.result as { id: string }).id
        expect((await sendConversationTurn(host, device, convId, 'turn 1', true)).state).toBe('settled')
        expect((await sendConversationTurn(host, device, convId, 'turn 2', false)).state).toBe('settled')
      } finally {
        await host.dispose()
      }
    })

    let turn3RunId = ''
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
        const device = await enrollLocal(host.service)
        const sent = await sendConversationTurn(host, device, convId, 'turn 3', false)
        expect(sent.state).toBe('settled')
        turn3RunId = sent.canonicalRunId

        const authority = host.orchestrationAuthority!
        expect(authority.sink.getTurn(convId, 1)?.delivery).toBe('accepted')
        const turn3 = authority.sink.getTurn(convId, 3)
        expect(turn3?.runId).toBe(turn3RunId)
        expect(turn3?.delivery).toBe('accepted')
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })

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
        const device = await enrollLocal(host.service)
        const sent = await sendConversationTurn(host, device, convId, 'turn 4 after restart', false)
        expect(sent.state).toBe('settled')

        const authority = host.orchestrationAuthority!
        expect(authority.sink.getTurn(convId, 3)?.runId).toBe(turn3RunId)
        const turn4 = authority.sink.getTurn(convId, 4)
        expect(turn4?.runId).toBe(sent.canonicalRunId)
        expect(turn4?.delivery).toBe('accepted')
        expect(authority.sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        await host.dispose()
      }
    })
  })
})
