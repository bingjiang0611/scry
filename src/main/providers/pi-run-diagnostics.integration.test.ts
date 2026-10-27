import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { withProbeFixture } from './pi-rpc.fixture'
import { createPiAdapter } from './pi'
import { PiRunDiagnostics } from './pi-run-diagnostics'

describe('Pi run diagnostic integration', () => {
  it.each([
    ['get_state', 'initial_state'], ['prompt', 'prompt_response']
  ] as const)('diagnoses a live RPC child withholding %s without ending or resending the run', async (command, phase) => {
    await withProbeFixture(async (profile, cwd) => {
      writeFileSync(join(cwd, `hold-${command}`), '')
      const diagnosticPath = join(cwd, 'diagnostics.json')
      const diagnostics = new PiRunDiagnostics(diagnosticPath)
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile, diagnostics })
      const events: TraceEvent[] = []
      let checkpoint!: () => void
      const waiting = new Promise<void>(resolve => { checkpoint = resolve })
      const handle = adapter.run({
        runId: 'diagnostic-hold', prompt: 'private-prompt-not-for-diagnostics', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit(event) {
          events.push(event)
          if (event.text?.includes('held RPC checkpoint')) checkpoint()
        }
      })
      try {
        await Promise.race([waiting, handle.promise.then(() => { throw new Error('run ended before held RPC') })])
        await diagnostics.flush()
        const content = readFileSync(diagnosticPath, 'utf8')
        const snapshot = JSON.parse(content).runs[0]
        expect(snapshot).toMatchObject({ runId: 'diagnostic-hold', phase, agentStarted: false, agentSettled: false, backgroundPending: false })
        expect(snapshot.rpcPid).toBe(Number(readFileSync(join(cwd, 'pid'), 'utf8')))
        expect(snapshot.history.map((entry: { phase: string }) => entry.phase)).toContain('environment')
        expect(content).not.toContain('private-prompt-not-for-diagnostics')
        expect(content).not.toContain(cwd)
        expect(existsSync(join(cwd, 'fixture-session.jsonl'))).toBe(false)
        expect(events.some(event => event.stage === 'result')).toBe(false)
        expect(readFileSync(join(cwd, 'commands'), 'utf8').split('\n').filter(value => value === command)).toHaveLength(1)
      } finally {
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
        await adapter.dispose?.()
      }
      // The production stop contract resolves an interrupted result; it does not reject.
      expect(JSON.parse(readFileSync(diagnosticPath, 'utf8')).runs[0]).toMatchObject({
        phase: 'provider_returned', providerStatus: 'interrupted', stopRequested: true
      })
    })
  })

  it.each(['continue', 'interrupt', 'transport-exit'] as const)('keeps async child ownership through parent idle: %s', async (action) => {
    await withProbeFixture(async (profile, cwd) => {
      const diagnosticPath = join(cwd, 'diagnostics.json')
      const diagnostics = new PiRunDiagnostics(diagnosticPath)
      const adapter = createPiAdapter({ listProfiles: async () => [profile], resolveProfile: async () => profile, diagnostics })
      const events: TraceEvent[] = []
      const startedAt = Date.now()
      onTestFailed(() => {
        const commands = join(cwd, 'commands')
        console.error('Pi idle-child lifecycle evidence', JSON.stringify({ action, elapsedMs: Date.now() - startedAt,
          events: events.map(event => ({ stage: event.stage, ms: Date.parse(event.ts) - startedAt })).slice(-24),
          commands: existsSync(commands) ? readFileSync(commands, 'utf8').slice(-4000) : 'not created' }))
      })
      let checkpoint!: () => void
      const waiting = new Promise<void>(resolve => { checkpoint = resolve })
      const handle = adapter.run({
        runId: 'background', prompt: 'background-child', cwd, agentProfileId: profile.id,
        attachments: [], permissionMode: 'full_access', emit(event) {
          events.push(event)
          if (event.text?.includes('child waiting checkpoint')) checkpoint()
        }
      })
      try {
        await Promise.race([waiting, handle.promise.then(() => { throw new Error('run ended before child checkpoint') })])
        expect(events.filter(event => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
          providerId: 'pi', phase: 'waiting', taskStop: 'unavailable', tasks: [{ taskId: 'child-1', description: 'worker' }]
        })
        expect(events.some(event => event.stage === 'result')).toBe(false)
        await diagnostics.flush()
        expect(JSON.parse(readFileSync(diagnosticPath, 'utf8')).runs[0]).toMatchObject({
          agentStarted: true, agentEnded: true, agentSettled: false, nativeIdle: true, backgroundPending: true,
          lastNativeLifecycle: 'agent_settled'
        })
        if (action === 'interrupt') handle.interrupt()
        else {
          // A missing reader must fail the fixture, not block Vitest's event loop
          // indefinitely inside writeFileSync on a FIFO.
          const release = spawnSync('/bin/sh', ['-c', 'printf "%s\\n" "$1" > "$2"', 'release-child',
            action === 'transport-exit' ? 'exit' : 'continue', join(cwd, 'release-child')], { timeout: 2_000 })
          expect(release.error).toBeUndefined()
          expect(release.status).toBe(0)
        }
        if (action === 'transport-exit') {
          await expect(handle.promise).rejects.toThrow()
          expect(events.filter(event => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
            phase: 'inactive', tasks: [{ taskId: 'child-1', status: 'unconfirmed' }]
          })
          expect(events.some(event => event.stage === 'result')).toBe(false)
        } else await expect(handle.promise).resolves.toMatchObject({ status: action === 'interrupt' ? 'interrupted' : 'completed' })
        if (action === 'continue') {
          expect(events.some(event => event.text === 'Child reviewed; parent continued')).toBe(true)
          expect(events.filter(event => event.stage === 'result')).toHaveLength(1)
          await diagnostics.flush()
          expect(JSON.parse(readFileSync(diagnosticPath, 'utf8')).runs[0]).toMatchObject({
            phase: 'provider_returned', providerStatus: 'completed', agentSettled: true, nativeIdle: false, backgroundPending: false,
            lastNativeLifecycle: 'agent_settled'
          })
        }
      } finally {
        handle.forceKill?.()
        await handle.promise.catch(() => undefined)
        await adapter.dispose?.()
      }
    })
  })

})
