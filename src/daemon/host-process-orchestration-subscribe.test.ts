import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'
import { startDaemonRunEvents } from '../main/daemon-run-events'
import { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { upsertTraceArchiveTurn } from '../main/transcript-archive'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

const savedMode = process.env.SCRY_ORCHESTRATION

afterEach(() => {
  if (savedMode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = savedMode
  cleanupTempDirs()
})

describe('Daemon local subscribe op (W16 P4-3 Unit 2)', () => {
  it('returns the legacy page from the actual host cache with the detail snapshot', async () => {
    process.env.SCRY_ORCHESTRATION = 'on'
    const root = tempDir()
    const userDataDir = join(root, 'userData')
    mkdirSync(userDataDir)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const cwd = realpathSync(workspace)
    const sessionId = 'old-native-session'
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
      sessionId, providerId: 'codex', cwd, preview: '之前的对话', ts: 100
    }]))
    for (const [i, userText] of ['问题一', '问题二'].entries()) {
      expect(upsertTraceArchiveTurn({
        cwd, sessionId, providerId: 'codex', runtimeProvider: 'codex_cli', userDataDir,
        turn: { runId: `legacy-run-${i}`, userText, items: [], done: true }
      })).toBe(true)
    }
    const daemon = await startTestDaemon({ root })
    try {
      const response = await daemon.request({
        op: 'subscribe', views: ['detail'], session: { sessionKey: sessionId }, waitMs: 0
      })
      expect(response.error).toBeUndefined()
      expect(response.subscribe).toMatchObject({
        mode: 'snapshot', snapshot: {
          detail: {
            legacyBefore: true, turns: [],
            firstPage: { turns: [{ userText: '问题一' }, { userText: '问题二' }], offset: 0, totalTurns: 2, hasOlder: false }
          }
        }
      })
      const payload = { sessionKey: sessionId, title: '来自投影的标题' }
      expect(daemon.host.orchestrationAuthority?.sink.execute({
        type: 'session.rename', commandId: 'rename-projected-session', scope: 'system', actor: 'system',
        at: Date.now(), payload, payloadSha256: sha256Hex(canonicalJson(payload))
      }).kind).toBe('accepted')
      const sidebar = await daemon.localOp('projectStore', 'listProjects', [])
      expect(sidebar.result).toContainEqual(expect.objectContaining({
        cwd,
        sessions: expect.arrayContaining([expect.objectContaining({
          externalSessionId: sessionId, preview: '来自投影的标题'
        })])
      }))
      const selected = await daemon.localOp('sessionHistory', 'loadSession', [{
        providerId: 'codex', cwd, externalSessionId: sessionId
      }])
      expect(selected.error).toBeUndefined()
      expect(selected.result).toMatchObject({
        page: {
          turns: [{ userText: '问题一' }, { userText: '问题二' }],
          projection: { sessionKey: sessionId, legacyBefore: true, activeRun: null }
        },
        selection: { cwd, externalSessionId: sessionId }
      })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('keeps the App run identity in the sidebar after authoritative settlement and restart', async () => {
    process.env.SCRY_ORCHESTRATION = 'on'
    let daemon = await startTestDaemon()
    const transport = new DaemonRunTransport((request) => daemon.request(request))
    const runtime = new DaemonRunRuntime({ transport, send: () => undefined })
    const events = startDaemonRunEvents({ transport, runtime, waitMs: 500, send: () => undefined })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    try {
      const first = await surface.start({
        providerId: 'codex', cwd: daemon.workspace, prompt: 'desktop remote write one', commandId: randomUUID()
      })
      const sink = daemon.host.orchestrationAuthority!.sink
      // The trace's completion notification can precede the durable settlement.
      const waitForSettlement = async (runId: string, count: number) => {
        await expect.poll(() => ({
          done: runtime.runView(runId)?.done,
          settlements: sink.listEvents().filter(event => event.type === 'run.settled').length
        }), { timeout: 10_000 }).toEqual({ done: true, settlements: count })
      }
      await waitForSettlement(first.runId, 1)
      const settled = sink.listEvents().find((event) => event.type === 'run.settled')
      expect(settled?.runId).toEqual(expect.any(String))
      expect(settled?.runId).not.toBe(first.runId)
      const queried = await transport.subscribe({
        views: ['activeRuns'], waitMs: 0, trackedRunIds: [settled!.runId!, randomUUID()]
      })
      expect(queried).toMatchObject({ mode: 'snapshot', snapshot: {
        activeRuns: { rows: [{ runId: settled!.runId, lifecycle: 'settled' }] }
      } })
      expect(queried.hints).toBeUndefined()
      const nativeSessionId = runtime.runView(first.runId)?.externalSessionId
      expect(nativeSessionId).toEqual(expect.any(String))
      const assertSidebar = async (runId: string): Promise<void> => {
        const sidebar = await daemon.localOp('projectStore', 'listProjects', [])
        expect(sidebar.result).toContainEqual(expect.objectContaining({
          cwd: daemon.workspace,
          sessions: expect.arrayContaining([expect.objectContaining({
            externalSessionId: nativeSessionId, runId, lastRunOutcome: 'completed'
          })])
        }))
      }
      await assertSidebar(first.runId)
      const next = await surface.start({
        providerId: 'codex', cwd: daemon.workspace, expectedExternalSessionId: nativeSessionId,
        prompt: 'desktop remote write two', commandId: randomUUID()
      })
      expect(next.runId).not.toBe(first.runId)
      await waitForSettlement(next.runId, 2)
      await assertSidebar(next.runId)
      expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
      daemon = await startTestDaemon({ root: daemon.root })
      await assertSidebar(next.runId)
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 30_000)

  it('exposes subscribe=1 on daemonInfo, streams events and W11 hostNotice on the local endpoint and requires a configured handler', async () => {
    process.env.SCRY_ORCHESTRATION = 'on'
    const daemon = await startTestDaemon()
    try {
      const info = await daemon.request({ op: 'daemonInfo' })
      expect(info.subscribe).toBe(1)

      const first = await daemon.request({ op: 'subscribe', views: ['sessions', 'activeRuns'], waitMs: 0 })
      expect(first.subscribe?.mode).toBe('snapshot')
      const { hostId, logId, seq } = first.subscribe as { hostId: string; logId: string; seq: number }
      expect(typeof hostId).toBe('string')
      expect(typeof logId).toBe('string')
      expect(Number.isSafeInteger(seq)).toBe(true)

      // Submit a run and confirm subscribe wakes with run events
      const intentId = randomUUID()
      const waiting = daemon.request({
        op: 'subscribe',
        views: ['sessions', 'activeRuns'],
        known: { hostId, logId, seq },
        waitMs: 5_000
      })
      const submitted = await daemon.request({
        op: 'submit',
        intentId,
        detail: JSON.stringify({ cwd: daemon.workspace, providerId: 'codex', prompt: 'hello subscribe' })
      })
      expect(submitted.status).toBe('recorded')
      const delta = await waiting
      expect(delta.subscribe?.mode).toBe('events')
      const eventTypes = (delta.subscribe?.events as Array<{ type: string }>).map((e) => e.type)
      expect(eventTypes).toContain('run.intent_recorded')

      // W11 host-admin notice arrives via hostNotice hint with unchanged payload
      const notice = daemon.host.hostAdmin.recordNotice({
        kind: 'device_approved_via_cli',
        deviceLabel: 'TestPhone',
        fingerprintPrefix: '0123456789abcdef'
      })
      const withNotice = await daemon.request({
        op: 'subscribe',
        views: ['sessions', 'activeRuns'],
        known: { hostId, logId, seq: delta.subscribe.seq as number },
        waitMs: 500
      })
      const hints = (withNotice.subscribe?.hints ?? []) as Array<{ kind: string; notice?: { id?: string; kind?: string; deviceLabel?: string } }>
      expect(hints.some((h) => h.kind === 'hostNotice' && h.notice?.id === notice.id && h.notice?.kind === 'device_approved_via_cli' && h.notice?.deviceLabel === 'TestPhone')).toBe(true)

      // The dispatcher must leave subscribe disabled when neither handler is supplied.
      const { dispatchRemoteRequest } = await import('../main/remote/inner-mtls-dispatch')
      const netReply = await dispatchRemoteRequest(
        daemon.host.service.controller,
        'a'.repeat(64),
        { protocol: 3, op: 'subscribe', views: ['activeRuns'], waitMs: 0 }
      )
      expect(netReply).toEqual({ error: 'unsupported_op' })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('keeps the subscription authoritative when a former mode value is still set', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      process.env.SCRY_ORCHESTRATION = mode
      const daemon = await startTestDaemon()
      try {
        const info = await daemon.request({ op: 'daemonInfo' })
        expect(info.subscribe).toBe(1)

        const sub = await daemon.request({ op: 'subscribe', views: ['activeRuns'], waitMs: 0 })
        expect(sub).toMatchObject({ subscribe: { mode: 'snapshot', snapshot: { activeRuns: { rows: [] } } } })

        const feed = await daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })
        expect(feed).toEqual({ error: 'unknown_op' })
      } finally {
        await daemon.dispose()
      }
    }
  }, 30_000)
})
