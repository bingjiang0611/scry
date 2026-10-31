// Loopback host side of the live concurrency trace lane (R6.3).
//
// Starts the real built App as a hidden process whose production remote host serves
// loopback TLS, and drives its own renderer over CDP with the typed local API: invite,
// approve a pairing, start the fixed runs, answer their one question, and read the final
// settlement. Only those reviewed `window.scry` calls are used — no generic eval/path IPC,
// no SSH, no network, no Keychain.
//
// Spawning and readiness are separate: `createHost().spawn()` returns as soon as the child
// exists (with its ownership record), and `ready()` performs the startup assertions. A
// failed startup therefore still has an owner that stops it.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { delay } from './concurrency-trace-live-samples.mjs'
import { ownedChild } from './concurrency-trace-live-lifecycle.mjs'
import { TRACE_QUESTION, assessEvidence, questionPolicy } from './concurrency-trace-live-question.mjs'

import {
  createOutputCapture,
  freePort,
  openRendererSession,
  openSnapshotChannel,
  readRendererMetrics,
  watchChildClose,
  writeBootstrap
} from '../session-concurrency-electron.mjs'

// Re-exported so the launcher and the focused tests have one import site for the contract.
export { TRACE_QUESTION, assessEvidence, questionPolicy }

/** Explicit environment allowlist: no credentials, no developer HOME, no relay. */
export function hostEnv({ home, tmp }) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '0',
    SCRY_TEST_APP: '1',
    SCRY_ELECTRON_SMOKE_PROVIDER: '1',
    SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi',
    SCRY_REMOTE_HOST: '1',
    SCRY_REMOTE_RELAY_ENABLED: '0'
  }
}

// Installed before the first start so a session/attention/turn-done event can never be
// missed. Keyed by runId because a question can arrive before the start reply is read.
export function installLiveHostDriver(policy, policyFor) {
  // Both arguments are explicit because this function is serialized into the host renderer:
  // a default parameter referencing module scope would not resolve there.
  // Single fixed question for this lane; a second pending question is a different lane.
  const QUESTION_PENDING = 1
  const starts = new Map()
  const sessions = new Map()
  const attentions = new Map()
  const questions = new Map()
  const terminals = new Map()
  const errors = new Map()
  const counts = { sessions: 0, questions: 0, attention: 0, terminal: 0, error: 0 }
  const listeners = [
    window.scry.onSession((event) => {
      counts.sessions++
      const previous = sessions.get(event.runId) ?? {}
      sessions.set(event.runId, {
        sessionId: event.sessionId,
        externalSessionId: event.externalSessionId ?? previous.externalSessionId ?? null,
        pending: event.pending === true,
        providerId: event.providerId ?? previous.providerId ?? null
      })
    }),
    // The global projection every run publishes, focused or not. This is the held evidence.
    window.scry.onQuestionAttention((event) => {
      counts.attention++
      const previous = attentions.get(event.runId)
      attentions.set(event.runId, {
        pendingCount: Number.isInteger(event.pendingCount) ? event.pendingCount : null,
        updates: (previous?.updates ?? 0) + 1,
        atMs: performance.now()
      })
    }),
    // Detail payloads are focused-only in production: kept for the focused regression, never
    // required for readiness, and never invented for a run that did not receive one.
    window.scry.onQuestion((request) => {
      counts.questions++
      questions.set(request.runId, {
        questionId: request.questionId,
        questions: (request.questions ?? []).map((prompt) => ({
          header: String(prompt.header ?? ''),
          question: String(prompt.question ?? ''),
          // The provider's own answer value wins over the visible label.
          options: (prompt.options ?? []).map((option) => String(option.answerValue ?? option.label ?? '')),
          multiSelect: prompt.multiSelect === true
        })),
        atMs: performance.now()
      })
    }),
    window.scry.onTurnDone((event) => {
      counts.terminal++
      terminals.set(event.runId, {
        stopped: event.stopped === true,
        externalSessionId: event.externalSessionId ?? null,
        sessionId: event.sessionId ?? null,
        atMs: performance.now()
      })
    }),
    // The real payload field is `message`; an older shape is kept only if it is really there.
    window.scry.onError((event) => {
      counts.error++
      const message = typeof event?.message === 'string' ? event.message : 'error event carried no message'
      if (event && typeof event.runId === 'string') errors.set(event.runId, message)
      else errors.set('unattributed', message)
    })
  ]
  window.__scryLiveHost = {
    counts,
    policy,
    start: async ({ cwd, prompt }) => {
      const started = await window.scry.start({ providerId: 'codex', cwd, prompt, expectedExternalSessionId: null })
      starts.set(started.runId, { cwd, prompt, replyHasExternalSessionId: typeof started.externalSessionId === 'string' })
      return { runId: started.runId, replyHasExternalSessionId: typeof started.externalSessionId === 'string' }
    },
    /**
     * Answers with the fixture policy's question id and answer text. When a detail payload
     * did arrive (the focused run) it must match that fixed contract exactly; a run that
     * never received a detail is answered from the policy and says so.
     */
    answer: async (runId) => {
      const expected = policyFor(runId, policy)
      const attention = attentions.get(runId)
      if (!attention || !Number.isInteger(attention.pendingCount) || attention.pendingCount < QUESTION_PENDING) {
        throw new Error(`no pending question attention for ${runId}`)
      }
      const detail = questions.get(runId)
      if (detail) {
        if (detail.questionId !== expected.questionId) throw new Error(`detail questionId ${detail.questionId} != fixture policy ${expected.questionId}`)
        const prompt = detail.questions[0]
        if (!prompt || prompt.question !== expected.question) throw new Error('detail question text differs from the fixture policy')
        if (prompt.options.length > 0) throw new Error('fixture policy expects an option-less question')
      }
      const answers = { [expected.question]: expected.answer }
      const accepted = await window.scry.answerQuestion({ runId, questionId: expected.questionId, behavior: 'answered', answers })
      return {
        accepted,
        questionId: expected.questionId,
        // Provenance: the id came from this lane's policy, never from a received payload.
        questionIdSource: 'fixture-policy',
        detail: detail ? 'available' : 'focused-only',
        detailMatchesPolicy: detail ? true : null,
        answers,
        attentionPendingCount: attention.pendingCount
      }
    },
    evidence: (runIds) => ({
      counts: { ...counts },
      runs: runIds.map((runId) => {
        const detail = questions.get(runId)
        const expected = policyFor(runId, policy)
        return {
          runId,
          start: starts.get(runId) ?? null,
          session: sessions.get(runId) ?? null,
          attention: attentions.get(runId) ?? null,
          question: detail ?? null,
          questionDetail: detail ? 'available' : 'focused-only',
          detailMatchesPolicy: detail
            ? detail.questionId === expected.questionId && detail.questions[0]?.question === expected.question && detail.questions[0]?.options.length === 0
            : null,
          terminal: terminals.get(runId) ?? null,
          error: errors.get(runId) ?? null
        }
      }),
      unattributedError: errors.get('unattributed') ?? null
    }),
    settle: async () => {
      const active = await window.scry.activeRuns()
      const startedAt = performance.now()
      const stats = await window.scry.stats()
      return {
        activeRunIds: active.map((run) => run.runId),
        sqlite: { status: stats.status, turns: stats.totals.turns, readMs: performance.now() - startedAt }
      }
    },
    listenerCount: listeners.length
  }
  return { installed: typeof window.__scryLiveHost === 'object', listeners: listeners.length }
}

const describe = (error) => (error instanceof Error ? error.message : String(error))

export function createHost({ root, electron, temp, workspaces, log }) {
  const userData = join(temp, 'host-userData')
  const home = join(temp, 'host-home')
  const tmp = join(temp, 'host-tmp')
  let child = null
  let lifecycle = null
  let capture = null
  let snapshots = null
  let session = null
  let state = { phase: 'created' }
  let driverListeners = 0

  async function spawnChild() {
    for (const dir of [userData, home, tmp]) mkdirSync(dir, { recursive: true })
    // The production workspace authorizer accepts only known projects.
    writeFileSync(join(userData, 'recent-folders.json'), JSON.stringify(workspaces.map((workspace) => resolve(workspace))))
    // The real entry point comes from the package metadata; its extension is not guessed.
    const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (typeof metadata.main !== 'string' || metadata.main.length === 0) throw new Error('package.json has no main entry for the built App')
    const mainPath = join(root, metadata.main)
    if (!existsSync(mainPath)) throw new Error(`built App entry is missing: ${mainPath}`)
    const bootstrap = writeBootstrap({ dir: join(temp, 'host-app'), root, metadata })
    const port = await freePort()
    capture = createOutputCapture({ onLine: (line) => log?.('host', line) })
    child = spawn(electron, [bootstrap, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
      '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
      env: hostEnv({ home, tmp }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    // Ownership exists as soon as the child does; readiness is a later, separate step.
    lifecycle = ownedChild({
      name: 'host',
      child,
      childClose: watchChildClose(child),
      snapshots: openSnapshotChannel(child),
      // Close the CDP socket before any signal so the App is not torn down mid-read.
      requestClose: async () => {
        session?.close?.()
        return { cdpClosed: session !== null }
      }
    })
    snapshots = lifecycle.snapshots
    child.stdout.on('data', capture.stdout)
    child.stderr.on('data', capture.stderr)
    child.once('exit', (code, signal) => log?.('host', `electron exited code=${code} signal=${signal}`))
    state = { phase: 'spawned', pid: child.pid, mainPath, port, userData, home, tmp }
    return state
  }

  const api = {
    get lifecycle() { return lifecycle },
    get child() { return child },
    get record() { return lifecycle?.record ?? null },
    get port() { return state.port ?? null },
    get userData() { return userData },
    get home() { return home },
    spawn: spawnChild,
    ready: async () => {
      if (!lifecycle) throw new Error('host was not spawned')
      return await lifecycle.ready(async () => {
        const startupProbe = {}
        const startedAt = Date.now()
        session = await openRendererSession(state.port, startupProbe)
        const { evaluate, wait } = session
        await wait('typeof window.scry === \'object\' && document.querySelector(\'textarea\') != null')
        const adapter = await evaluate('window.scry.detectFast().then(items => items.map(item => ({ id: item.id, name: item.name })))')
        if (JSON.stringify(adapter) !== JSON.stringify([{ id: 'codex', name: 'codex Smoke Fixture' }])) {
          throw new Error(`refusing to measure without the offline fixture adapter: ${JSON.stringify(adapter)}`)
        }
        // This lane reaches the host over loopback TLS only; the SSH listener stays opt-in off.
        const sshStatus = await evaluate('window.scry.remoteDesktopHostStatus()')
        if (sshStatus?.enabled !== false) throw new Error(`the SSH listener must stay off for this lane: ${JSON.stringify(sshStatus)}`)
        const remote = await evaluate(`(async () => {
          const deadline = Date.now() + 15000
          while (Date.now() < deadline) {
            const status = await window.scry.remoteStatus()
            if (status.enabled) return status
            await new Promise((done) => setTimeout(done, 50))
          }
          throw new Error('remote host initialization timed out')
        })()`)
        if (remote.relayConfigured !== false) throw new Error('the relay must stay unconfigured for this lane')
        // Both the installer and the policy helper are serialized: the renderer has no module
        // scope, so the policy object and the id/answer derivation travel with it.
        const driver = await evaluate(`(${installLiveHostDriver.toString()})(${JSON.stringify(TRACE_QUESTION)}, ${questionPolicy.toString()})`)
        if (driver.installed !== true) throw new Error('host driver did not install')
        driverListeners = driver.listeners
        return {
          startupMs: Date.now() - startedAt,
          remote,
          sshStatus,
          adapter,
          driverListeners,
          startupProbe,
          userData,
          home
        }
      })
    },
    /** Boundary sample. Renderer CDP metrics are taken only at wave boundaries by default. */
    sample: async (label, { renderer = false } = {}) => {
      const main = await snapshots.take(label)
      const rendererState = renderer && session
        ? await readRendererMetrics(session.send).then((metrics) => ({ status: 'measured', metrics }), (error) => ({ status: 'unavailable', reason: describe(error) }))
        : { status: 'unavailable', reason: 'host renderer metrics are taken at wave boundaries only, outside the visit window' }
      return { label, takenAtEpochMs: Date.now(), main, renderer: rendererState }
    },
    evaluate: (expression) => session.evaluate(expression),
    start: (cwd, prompt) => session.evaluate(`window.__scryLiveHost.start(${JSON.stringify({ cwd, prompt })})`),
    answer: (runId) => session.evaluate(`window.__scryLiveHost.answer(${JSON.stringify(runId)})`),
    invite: async () => {
      const invitation = await session.evaluate('window.scry.remoteDesktopHostInvite()')
      if (typeof invitation !== 'string' || !invitation.startsWith('scry-desktop1:')) throw new Error('host did not return an invitation')
      const payload = JSON.parse(Buffer.from(invitation.slice('scry-desktop1:'.length), 'base64url').toString('utf8'))
      return { invitation, pairingId: payload.pairingId, hostId: payload.hostId, pairPort: payload.pairPort, runPort: payload.runPort, expiresAt: payload.expiresAt }
    },
    confirmPairing: (pairingId, publicKeySHA256) => session.evaluate(`window.scry.remoteConfirmPairing(${JSON.stringify(pairingId)}, ${JSON.stringify(publicKeySHA256)})`),
    /**
     * Waits for the real question evidence and fails fast: an App error, a stopped run or a
     * run that terminated before publishing its question is reported immediately, not after
     * the deadline. Readiness comes from `assessEvidence`, whose evidence is the broadcast
     * attention projection — production only sends the detail payload to the focused run.
     */
    waitEvidence: async (runIds, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        last = await session.evaluate(`window.__scryLiveHost.evidence(${JSON.stringify(runIds)})`)
        if (last.unattributedError) throw new Error(`host reported an unattributed error: ${last.unattributedError}`)
        // Readiness and the held set both come from the global attention evidence plus the
        // session, never from a detail payload (those are focused-only).
        const assessment = assessEvidence({ runs: last.runs, runIds })
        if (assessment.issues.length > 0) {
          const first = assessment.issues[0]
          throw new Error(`${first.phase} for ${first.runId}: ${first.error}`)
        }
        if (assessment.ready) return { ...last, held: assessment.held, assessment }
        await delay(50)
      }
      throw new Error(`host evidence timed out: ${JSON.stringify({ counts: last?.counts, pending: last ? assessEvidence({ runs: last.runs, runIds }).pending : null })}`)
    },
    waitTerminals: async (runIds, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        last = await session.evaluate(`window.__scryLiveHost.evidence(${JSON.stringify(runIds)})`)
        if (last.unattributedError) throw new Error(`host reported an unattributed error: ${last.unattributedError}`)
        if (last.runs.every((run) => run.terminal)) return last
        await delay(50)
      }
      throw new Error(`host terminal timed out: ${JSON.stringify(last?.runs.map((run) => ({ runId: run.runId, terminal: run.terminal, error: run.error })))}`)
    },
    settle: () => session.evaluate('window.__scryLiveHost.settle()'),
    driverListeners: () => driverListeners,
    shutdown: async (reason) => {
      const record = lifecycle ? await lifecycle.shutdown(reason) : null
      if (capture) state.log = { text: capture.finish(), truncated: capture.truncated() }
      return record
    },
    logState: () => state
  }
  return api
}
