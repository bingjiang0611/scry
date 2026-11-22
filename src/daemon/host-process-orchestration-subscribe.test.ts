import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

const savedMode = process.env.SCRY_ORCHESTRATION

afterEach(() => {
  if (savedMode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = savedMode
  cleanupTempDirs()
})

describe('Daemon local subscribe op (W16 P4-3 Unit 2)', () => {
  it('exposes subscribe=1 on daemonInfo, streams events & W11 hostNotice on local endpoint, and rejects subscribe on network endpoint in on mode', async () => {
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

      const { dispatchRemoteRequest } = await import('../main/remote/inner-mtls-dispatch')
      const netReply = await dispatchRemoteRequest(
        daemon.host.service.controller,
        'a'.repeat(64),
        { protocol: 2, op: 'subscribe', views: ['activeRuns'], waitMs: 0 }
      )
      expect(netReply).toEqual({ error: 'unsupported_op' })
    } finally {
      await daemon.dispose()
    }
  }, 30_000)

  it('omits subscribe capability and returns unsupported_op in off and shadow modes while keeping appEvents unchanged', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      process.env.SCRY_ORCHESTRATION = mode
      const daemon = await startTestDaemon()
      try {
        const info = await daemon.request({ op: 'daemonInfo' })
        expect(info.subscribe).toBeUndefined()

        const sub = await daemon.request({ op: 'subscribe', views: ['activeRuns'], waitMs: 0 })
        expect(sub).toEqual({ error: 'unsupported_op' })

        const feed = await daemon.request({ op: 'appEvents', cursor: 0, waitMs: 0 })
        expect(typeof feed.events?.epoch).toBe('string')
      } finally {
        await daemon.dispose()
      }
    }
  }, 30_000)
})
