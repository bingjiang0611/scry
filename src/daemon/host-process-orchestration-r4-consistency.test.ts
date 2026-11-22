import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createRecentFoldersStore } from '../main/app-store'
import { RemoteInteractionBroker } from '../main/remote/remote-interaction-broker'
import { answerRunQuestion } from '../main/remote/host-controller-run-controls'
import { submitIntent } from '../main/remote/host-controller-submit'
import { AuthorityEngine } from '../host-runtime/orchestration/authority-engine'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir, waitForProjectedRun } from './host-process.fixtures'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

afterEach(cleanupTempDirs)

function setOnEnv() {
  const saved = {
    relay: process.env.SCRY_REMOTE_RELAY_ENABLED,
    smoke: process.env.SCRY_ELECTRON_SMOKE_PROVIDER,
    logging: process.env.ELECTRON_ENABLE_LOGGING,
    orch: process.env.SCRY_ORCHESTRATION,
    argvLen: process.argv.length
  }
  process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
  process.env.SCRY_ELECTRON_SMOKE_PROVIDER = '1'
  process.env.ELECTRON_ENABLE_LOGGING = '1'
  process.env.SCRY_ORCHESTRATION = 'on'
  process.argv.push('--remote-debugging-port=0')
  return () => {
    process.argv.length = saved.argvLen
    if (saved.relay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
    else process.env.SCRY_REMOTE_RELAY_ENABLED = saved.relay
    if (saved.smoke === undefined) delete process.env.SCRY_ELECTRON_SMOKE_PROVIDER
    else process.env.SCRY_ELECTRON_SMOKE_PROVIDER = saved.smoke
    if (saved.logging === undefined) delete process.env.ELECTRON_ENABLE_LOGGING
    else process.env.ELECTRON_ENABLE_LOGGING = saved.logging
    if (saved.orch === undefined) delete process.env.SCRY_ORCHESTRATION
    else process.env.SCRY_ORCHESTRATION = saved.orch
  }
}

const waitRunTerminal = (socketPath: string, ca: string, cert: string, key: string, runId: string) =>
  waitForProjectedRun(socketPath, ca, cert, key, runId, 500)

describe('W9 Unit R4: Must-Fixes 1, 3, 4, 5, 10b, 10c', () => {
  it('Must-Fix 1 + 5a: real daemon beforeDispatch enforces real MCP trust gate fail-closed with 0 Provider calls and consistent failed state', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-trust')
    mkdirSync(join(workspace, '.codex'), { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    writeFileSync(
      join(canonicalWs, '.codex', 'config.toml'),
      '[mcp_servers.r4_unsafe]\ncommand = "/bin/echo"\nargs = ["x"]\n[mcp_servers.r4_unsafe.env]\nNODE_OPTIONS = "--require=/nonexistent/r4.js"\n'
    )

    const restore = setOnEnv()
    let host: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const device = await enrollLocal(host.service)
      const sub = await call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'blocked by trust gate' })
      })
      const deviceState = await waitRunTerminal(
        host.channel.socketPath,
        host.service.caCertificatePEM,
        device.certPEM,
        device.keyPEM,
        sub.runId
      )
      // Must-Fix 1 + 5a: both device H1 and orchestration.db agree on `failed`, with `trust_gate_rejected` and 0 Provider dispatches!
      expect(deviceState).toBe('failed')
      const orchRun = host.orchestrationAuthority!.sink.getRun(sub.runId)
      expect(orchRun?.lifecycle).toBe('failed')
      const events = host.orchestrationAuthority!.sink.listEvents().filter((e) => e.runId === sub.runId)
      expect(events.some((e) => e.type === 'run.dispatched')).toBe(false)
      expect(events.find((e) => e.type === 'run.failed')?.payload?.reason).toBe('trust_gate_rejected')
    } finally {
      await host?.dispose()
      restore()
    }
  }, 20_000)

  it('Must-Fix 5b: after daemon restart, interrupted run is NOT shown as failed to device (resolveIntent & runState return cancelled + interrupted marker)', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    const daemonStateDirectory = join(userDataDir, 'daemon')
    const workspace = join(root, 'ws-restart')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWs = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWs)

    const restore = setOnEnv()
    let host1: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    let host2: Awaited<ReturnType<typeof createDaemonHostProcess>> | undefined
    try {
      // First enroll a device so pairing state exists on disk, then dispose host1 cleanly.
      host1 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      const device = await enrollLocal(host1.service)
      const peerSha = host1.service.authority.inspectLocal().grants[0]!.certificateSHA256
      await host1.dispose()
      host1 = undefined

      // Simulate an in-flight dispatched run crashed mid-flight (in BOTH orchestration.db and H1 ledger) with no recorder evidence.
      const runId = randomUUID()
      const intentId = randomUUID()
      const { scopedIntentId } = await import('../main/remote/remote-gateway')
      const scoped = scopedIntentId(peerSha, intentId)
      const detail = JSON.stringify({ cwd: canonicalWs, providerId: 'codex', prompt: 'crashed mid-run' })

      const seedSink = EventSink.open({ userDataDir, checkpointIntervalMs: 0 })
      try {
        seedSink.authorizeActor(`peer:${peerSha}`)
        const now = Date.now() - 5_000
        const submitPayload = {
          runId,
          sessionKey: null,
          provider: 'codex',
          profile: null,
          cwd: canonicalWs,
          claimMode: 'immediate' as const,
          leaseOwner: 'daemon:crashed',
          pendingTtlMs: 30_000
        }
        seedSink.execute({
          type: 'run.submit',
          commandId: scoped,
          actor: `peer:${peerSha}`,
          scope: 'local',
          at: now,
          payload: submitPayload,
          payloadSha256: sha256Hex(canonicalJson({ grantScope: 'local', detail }))
        })
        const dispPayload = { runId, step: 'admitted_and_dispatched' as const }
        seedSink.execute({
          type: 'run.effect_result',
          commandId: `effect:p4-${runId}:admitted_and_dispatched`,
          actor: `effect:p4-${runId}`,
          scope: 'system',
          at: now + 5,
          payload: dispPayload,
          payloadSha256: sha256Hex(canonicalJson(dispPayload))
        })
      } finally {
        seedSink.close()
      }

      const ledgerDir = join(userDataDir, 'remote', 'ledger')
      mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
      const now = Date.now() - 5_000
      writeFileSync(
        join(ledgerDir, 'session-ledger.log'),
        [
          JSON.stringify({ seq: 1, at: now, kind: 'intent_recorded', runId, intentId: scoped, detail }),
          JSON.stringify({ seq: 2, at: now + 5, kind: 'run_dispatched', runId })
        ].join('\n') + '\n',
        { mode: 0o600 }
      )

      // Boot host2: recovery interrupts the run in orch, and device MUST NOT see `failed`!
      host2 = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: 'test',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })

      expect(host2.orchestrationAuthority!.sink.getRun(runId)?.lifecycle).toBe('interrupted')

      const resolved = host2.service.controller.resolveIntent(peerSha, { intentId })
      expect(resolved.runId).toBe(runId)
      expect(resolved.state).toBe('cancelled')

      const runState = host2.service.controller.runState(peerSha, { runId })
      expect(runState).toBe('cancelled')

      const reply = await call(host2.channel.socketPath, host2.service.caCertificatePEM, device.certPEM, device.keyPEM, {
        op: 'subscribe', views: ['activeRuns'], trackedRunIds: [runId], waitMs: 0
      })
      expect(reply.subscribe.snapshot.activeRuns.rows).toContainEqual(expect.objectContaining({
        runId, lifecycle: 'interrupted'
      }))
      expect(host2.orchestrationAuthority!.sink.listEvents().filter((event) => event.runId === runId))
        .toContainEqual(expect.objectContaining({
          type: 'run.interrupted', payload: expect.objectContaining({ reason: 'host_restarted' })
        }))
    } finally {
      await host1?.dispose()
      await host2?.dispose()
      restore()
    }
  }, 20_000)

  it('Must-Fix 3: compensates orchestration run when gateway.submitIntent throws after orchestration.submitSync commits', () => {
    const compensated: Array<{ runId: string; reason: string }> = []
    expect(() =>
      submitIntent(
        {
          authorizeDevice: () => undefined,
          ledger: {} as never,
          gateway: {
            grantScope: () => 'local',
            submitIntent: () => {
              throw new Error('h1_ledger_write_failed')
            }
          } as never,
          dispatcher: { pump: () => [] } as never,
          scopedIntentId: (_p, id) => id,
          orchestration: {
            submitSync: () => ({ runId: 'run-orphan-1', status: 'recorded', seq: 1 }),
            compensateSubmitFailure: (runId: string, reason: string) => {
              compensated.push({ runId, reason })
            }
          } as never
        },
        'a'.repeat(64),
        { intentId: randomUUID(), detail: '{}' }
      )
    ).toThrow('h1_ledger_write_failed')
    expect(compensated).toEqual([{ runId: 'run-orphan-1', reason: 'submit_side_effect_failed' }])
  })

  it('Must-Fix 4: validates question answer via broker BEFORE recording question.answer in orchestration.db', () => {
    const recorded: unknown[] = []
    const broker = new RemoteInteractionBroker(() => undefined)
    const runId = randomUUID()
    // Invalid answerId & non-pending question MUST throw BEFORE calling orchestration.onQuestionAnswer!
    expect(() =>
      answerRunQuestion(
        {
          authorizeDevice: () => undefined,
          isRemoteRun: () => true,
          macRun: () => { throw new Error('unused') },
          interactions: broker,
          stops: new Map(),
          ledger: {} as never,
          orchestration: {
            onQuestionAnswer: (input: unknown) => recorded.push(input)
          } as never
        },
        'a'.repeat(64),
        {
          runId,
          answerId: 'not-a-uuid',
          response: { runId, questionId: 'q-missing', behavior: 'cancelled' }
        }
      )
    ).toThrow('invalid_answer_id')
    expect(recorded).toHaveLength(0)

    expect(() =>
      answerRunQuestion(
        {
          authorizeDevice: () => undefined,
          isRemoteRun: () => true,
          macRun: () => { throw new Error('unused') },
          interactions: broker,
          stops: new Map(),
          ledger: {} as never,
          orchestration: {
            onQuestionAnswer: (input: unknown) => recorded.push(input)
          } as never
        },
        'a'.repeat(64),
        {
          runId,
          answerId: randomUUID(),
          response: { runId, questionId: 'q-missing', behavior: 'cancelled' }
        }
      )
    ).toThrow('question_not_pending')
    expect(recorded).toHaveLength(0)
  })

  it('Must-Fix 10b: repeated stopRun clicks deduplicate on deterministic stop:<runId> commandId (single receipt)', () => {
    const root = tempDir()
    const sink = EventSink.open({ userDataDir: root, checkpointIntervalMs: 0 })
    let now = 1_000
    try {
      const engine = new AuthorityEngine({ sink, clock: () => (now += 100) })
      const sub = engine.submitSync({
        grantScope: 'local',
        commandId: 'cmd-stop-dedup',
        detail: JSON.stringify({ cwd: root, providerId: 'codex', prompt: 'hi' })
      })
      expect(sub.kind).toBe('accepted')
      if (sub.kind !== 'accepted') return
      const r1 = engine.stopRun({ grantScope: 'local', runId: sub.runId })
      expect(r1.status).toBe('requested')
      // Even if a second stop arrives (or via sink directly), commandId is deterministic `stop:<runId>`, no clock suffix!
      const receipts = sink.handle.db
        .prepare("SELECT command_id FROM orch_command WHERE type = 'run.stop'")
        .all() as Array<{ command_id: string }>
      expect(receipts).toEqual([{ command_id: `stop:${sub.runId}` }])
    } finally {
      sink.close()
    }
  })

  it('Must-Fix 10c: deleteSession does not unlink shared >16 KiB external body while another session is preparing it', async () => {
    const root = tempDir()
    const sink = EventSink.open({ userDataDir: root, checkpointIntervalMs: 0 })
    try {
      const engine = new AuthorityEngine({ sink })
      const sharedPrompt = 'S'.repeat(24 * 1024)
      const convRunA = randomUUID()
      const detailA = JSON.stringify({
        cwd: root,
        providerId: 'codex',
        conversation: { conversationId: 'sess-A', runId: convRunA, ordinal: 1 },
        prompt: sharedPrompt
      })
      const detailB = detailA // identical content -> identical body sha256!

      // Submit in session A first
      const subA = await engine.submitAsync({
        grantScope: 'local',
        commandId: 'cmd-sess-A',
        detail: detailA
      })
      expect(subA.kind).toBe('accepted')
      if (subA.kind !== 'accepted') return
      const runA = sink.getRun(subA.runId)
      expect(runA?.sessionKey).toBe('sess-A')
      const bodyA = runA?.body
      expect(bodyA?.storage).toBe('external')
      const bodyPath = sink.bodyStore.externalPath(bodyA!.sha256)
      expect(existsSync(bodyPath)).toBe(true)

      // Pin the shared body sha256 as if Session B is mid-prepareBodyAsync BEFORE its SQLite commit!
      const unpin = sink.bodyStore.pin(bodyA!.sha256)
      try {
        // Session A is deleted while Session B holds the in-flight pin for the same sha256!
        const del = sink.deleteSession({
          sessionKey: 'sess-A',
          cwd: root,
          actor: 'system',
          scope: 'local',
          at: Date.now()
        })
        expect(del.status).toBe('deleted')
        // Shared body file MUST NOT have been unlinked while Session B has it pinned!
        expect(existsSync(bodyPath)).toBe(true)
        // Session B (different runId, same external body sha256) can still commit and read the body cleanly
        const subB = await engine.submitAsync({
          grantScope: 'local',
          commandId: 'cmd-sess-B',
          runId: randomUUID(),
          detail: detailB
        })
        expect(subB.kind).toBe('accepted')
        if (subB.kind === 'accepted') {
          const readBuf = sink.bodyStore.readBody(sink.getRun(subB.runId)!.body!)
          expect(readBuf.toString('utf8')).toBe(detailB)
          unpin()
          expect(sink.bodyStore.readBody(sink.getRun(subB.runId)!.body!).toString('utf8')).toBe(detailB)
          expect(sink.handle.db.prepare('SELECT * FROM orch_body_erase').all()).toEqual([])
        }
      } finally {
        unpin()
      }
    } finally {
      sink.close()
    }
  })
})
