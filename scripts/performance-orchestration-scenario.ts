import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { buildMcpExecutionSnapshot } from '../src/main/mcp-execution-trust'
import type { Fixture, Scenario } from './performance-baseline-fixture'

const PEER_SHA = 'b'.repeat(64)

type LoadedOrchestrationModules = {
  EventSink: typeof import('../src/host-runtime/orchestration/event-sink').EventSink
  AuthorityEngine: typeof import('../src/host-runtime/orchestration/authority-engine').AuthorityEngine
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const authorityEngineModulePath = join(repoRoot, 'src/host-runtime/orchestration/authority-engine.ts')
const eventSinkModulePath = join(repoRoot, 'src/host-runtime/orchestration/event-sink.ts')

let loadedPromise: Promise<LoadedOrchestrationModules | null> | undefined

function loadOrchestrationModules(): Promise<LoadedOrchestrationModules | null> {
  if (!loadedPromise) {
    if (!existsSync(authorityEngineModulePath) || !existsSync(eventSinkModulePath)) {
      loadedPromise = Promise.resolve(null)
    } else {
      loadedPromise = Promise.all([
        import('../src/host-runtime/orchestration/event-sink'),
        import('../src/host-runtime/orchestration/authority-engine')
      ]).then(([sinkMod, engineMod]) => ({
        EventSink: sinkMod.EventSink,
        AuthorityEngine: engineMod.AuthorityEngine
      }))
    }
  }
  return loadedPromise
}

/**
 * P4-2 pre-first-token orchestration commit budget scenario (P95 <= 8 ms absolute, fullfsync=ON).
 * Exercises the REAL `AuthorityEngine.submitAsync` (with §2.3 pre-dispatch checks + single-commit
 * immediate dispatch) + `AuthorityEngine.beforeDispatch` hook path (`realpathSync`, workspace
 * authorization, peer authorization, MCP trust gate, body check, 1 fullfsync SQLite commit).
 * Loads orchestration modules dynamically so ABAB baselines (e.g. `main`) lacking P4-2 modules never crash.
 */
export function createOrchestrationPreFirstTokenScenario(fixture: Fixture): Scenario {
  let seq = 0
  let engine: InstanceType<LoadedOrchestrationModules['AuthorityEngine']> | undefined
  let measuredCommits = 0
  const canonicalWorkspace = realpathSync(fixture.workspace)

  return {
    lane: 'disk',
    workload: 'orchestration-pre-first-token=real-hooks+1-commit;pragma-fullfsync=on(darwin-F_FULLFSYNC)',
    iterations: 2,
    warmups: 1,
    samples: 20,
    run: async () => {
      const mods = await loadOrchestrationModules()
      if (!mods) {
        return { __baselineUnavailable: 1 }
      }
      if (!engine) {
        const sink = mods.EventSink.open({
          userDataDir: join(fixture.root, 'orch-bench'),
          fullfsync: true,
          checkpointFullfsync: true,
          checkpointIntervalMs: 0,
          maxActiveRuns: 10_000
        })
        engine = new mods.AuthorityEngine({
          sink,
          leaseOwner: 'bench',
          pendingTtlMs: 30_000,
          onCommitTiming: (sample) => {
            if (sample.preFirstToken) measuredCommits += 1
          }
        })
      }

      const db = engine.sink.handle.db
      const commitsBefore = measuredCommits
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS c FROM orch_event').get() as { c: number }).c
      const outboxBefore = (db.prepare('SELECT COUNT(*) AS c FROM orch_outbox').get() as { c: number }).c

      const id = ++seq
      const detail = JSON.stringify({
        providerId: 'codex',
        cwd: canonicalWorkspace,
        prompt: `fixed orchestration pre-first-token prompt #${id}`
      })
      const submitted = await engine.submitAsync({
        peerCertSHA256: PEER_SHA,
        grantScope: 'remote',
        commandId: `bench-cmd-${id}`,
        detail,
        immediateDispatch: {
          authorizeWorkspace: (cwd) => realpathSync(cwd),
          isPeerAuthorized: (peer) => peer === PEER_SHA,
          isProviderAuthenticating: () => false,
          verifyTrustGate: () => {
            const snapshot = buildMcpExecutionSnapshot({
              providerId: 'codex',
              cwd: canonicalWorkspace,
              homeDir: fixture.home,
              env: process.env
            })
            return snapshot.errors.length === 0
          }
        }
      })
      expect(submitted.kind).toBe('accepted')
      if (submitted.kind !== 'accepted') throw new Error(`unexpected submit result: ${submitted.kind}`)

      const gate = engine.beforeDispatch({
        runId: submitted.runId,
        cwd: canonicalWorkspace,
        provider: 'codex',
        profile: null,
        actor: `peer:${PEER_SHA}`,
        authorizeWorkspace: (cwd) => realpathSync(cwd),
        isPeerAuthorized: (peer) => peer === PEER_SHA,
        isProviderAuthenticating: () => false,
        verifyTrustGate: () => true
      })
      expect(gate.ok).toBe(true)

      const commits = measuredCommits - commitsBefore
      const events = (db.prepare('SELECT COUNT(*) AS c FROM orch_event').get() as { c: number }).c - eventsBefore
      const outboxRows = (db.prepare('SELECT COUNT(*) AS c FROM orch_outbox').get() as { c: number }).c - outboxBefore
      return { commits, events, outboxRows }
    }
  }
}
