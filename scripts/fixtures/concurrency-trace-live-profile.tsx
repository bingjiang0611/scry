// Measurement-only renderer for the live concurrency trace fixture (R6.2).
//
// Mounts the production RemoteChat against a hidden Electron main that runs the
// real DesktopRemoteClient over loopback TLS. This file owns three things only:
// the fixture IPC bridge (window.scry.desktopRemote → main), the controlled poll
// (the production poll is registered here and only the driver may call it), and
// the per-round measurements handed to the launcher.
import { Profiler, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RemoteChat } from '../../src/renderer/components/RemoteChat'
import { createComposerDraftStore } from '../../src/renderer/composer-drafts'
import { RemotePromptQueueStore } from '../../src/renderer/remote-prompt-queue'
import { createRightSurfaceState } from '../../src/renderer/right-surface'
import { refreshRemoteCatalog } from '../../src/renderer/hooks/useRemoteCatalogs'
import type { RemoteSessionRef } from '../../src/shared/desktop-remote'
import {
  callDelta,
  LIVE_BRIDGE_KEY,
  LIVE_DRIVER_KEY,
  LiveVisitLedger,
  roundViolations,
  type LiveRoundSample,
  type LiveVisitSummary
} from './concurrency-trace-live-visits'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

// Visible marker the smoke fixture emits after its 1000 seeds (R6.1 branch in
// src/main/providers/smoke.ts). It is the only text this fixture looks for.
const MARKER_TEXT = 'concurrency trace ready'

export interface LiveVisitTarget {
  visitId: string
  connectionId: string
  cwd: string
  providerId: string
  agentProfileId?: string
  /** Real host session evidence; the launcher builds this from its own catalog. */
  session: RemoteSessionRef
  /** Host-local run the launcher already confirmed; the committed view must match it. */
  nativeRunId: string
}

interface LiveReadContext { cwd: string; providerId: string; agentProfileId?: string; externalSessionId?: string }

/** Production's own catalog evidence, copied verbatim for diagnostics (never recomputed). */
interface PollDiagnostics {
  catalogTraceDelta: number | null
  sessionCount: number | null
  activeSessionCount: number
  catalogSessions: Array<{ externalSessionId: string | null; cwd: string; providerId: string; agentProfileId: string | null; isActive: boolean }>
}

interface PollRegistration {
  poll: () => Promise<void>
  context: LiveReadContext
  contextKey: string
  connectionId: string
  connected: boolean
  catalogReady: boolean
  /** Production's activity flag for this exact session (`catalogSession.isActive`). */
  sessionActive: boolean
  /** Production's advertised traceDelta capability (`catalog.traceDelta === 1`). */
  traceDelta: boolean
  diagnostics: PollDiagnostics
}

interface HostBridge { call(method: string, args: unknown[]): Promise<unknown> }

interface MarkerState { visible: boolean; reason: string; width: number; height: number }

const bridge = (window as unknown as Record<string, HostBridge | undefined>)[LIVE_BRIDGE_KEY]
if (!bridge) throw new Error(`concurrency-trace-live fixture requires the ${LIVE_BRIDGE_KEY} preload bridge`)

// Sub-second timers (animation-frame fallbacks, debounces) stay native. Interval
// polling at 1s or slower is captured so the driver, not a background interval,
// decides when the next read runs. This measures controlled refreshes only.
const nativeSetInterval = window.setInterval.bind(window)
const nativeClearInterval = window.clearInterval.bind(window)
const capturedTimers = new Set<number>()
let nextTimer = 1_000_000
window.setInterval = ((callback: TimerHandler, delay?: number, ...rest: unknown[]) => {
  if ((delay ?? 0) >= 1000) { const id = ++nextTimer; capturedTimers.add(id); return id }
  return nativeSetInterval(callback, delay, ...rest)
}) as typeof window.setInterval
window.clearInterval = ((id?: number) => { if (id === undefined || !capturedTimers.delete(id)) nativeClearInterval(id) }) as typeof window.clearInterval

const unexpected: string[] = []
// Function declaration, not an arrow: TypeScript only treats a never-returning
// declaration as terminating control flow, which the narrowing below relies on.
function recordUnexpected(name: string): never {
  unexpected.push(name)
  throw new Error(`concurrency-trace-live fixture does not implement ${name}`)
}

const bump = (bucket: Record<string, number>, key: string): void => { bucket[key] = (bucket[key] ?? 0) + 1 }

// Per-method renderer counters. Every read RemoteChat issues goes through here,
// including mount-time list/catalog/history and any read that throws, so neither
// setup nor a failed poll can look like a successful one.
let calls: Record<string, number> = {}
let failed: Record<string, number> = {}
const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
  bump(calls, method)
  try {
    return await bridge.call(method, args)
  } catch (error) {
    bump(failed, method)
    throw error
  }
}

let authorizedConnectionId: string | undefined
const expectConnection = (connectionId: unknown): void => {
  if (authorizedConnectionId === undefined) recordUnexpected('desktopRemote before beginVisit')
  // Main maps peer → connection; the frame may only name the visit's own host.
  if (connectionId !== authorizedConnectionId) recordUnexpected(`desktopRemote for another connection: ${String(connectionId)}`)
}

const desktopRemote: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  list: () => call('list'),
  catalog: (connectionId: unknown) => { expectConnection(connectionId); return call('catalog') },
  history: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('history', ...rest) },
  intents: (connectionId: unknown) => { expectConnection(connectionId); return call('intents') },
  liveRun: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('liveRun', ...rest) },
  runStatus: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('runStatus', ...rest) },
  trace: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('trace', ...rest) },
  traceDelta: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('traceDelta', ...rest) },
  commands: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('commands', ...rest) },
  providerControls: (connectionId: unknown, ...rest: unknown[]) => { expectConnection(connectionId); return call('providerControls', ...rest) }
}
const desktopRemoteProxy = new Proxy(desktopRemote, {
  get: (target, name) => {
    if (typeof name !== 'string') return undefined
    return target[name] ?? (() => recordUnexpected(`window.scry.desktopRemote.${name}`))
  }
})
// No on* stubs: a fixture that tolerated unknown subscriptions would hide a real
// requirement instead of reporting it.
;(window as unknown as { scry: unknown }).scry = new Proxy({ desktopRemote: desktopRemoteProxy } as Record<string, unknown>, {
  get: (target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in target) return target[name]
    return recordUnexpected(`window.scry.${name}`)
  }
})

let commits = 0
let commitMs = 0
let autoPolls = 0
let registration: PollRegistration | undefined
const ledger = new LiveVisitLedger()
let visitTarget: LiveVisitTarget | undefined
let root: Root | undefined
// Published by the build-injected commit hook, never by a render-phase write.
let committedRun: unknown
let commitSeq = 0

const nextFrame = (): Promise<void> => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const requireVisit = (): LiveVisitTarget => visitTarget ?? recordUnexpected('driver call without beginVisit')

function publishRun(run: unknown): void {
  committedRun = run
  commitSeq++
}

function releaseRun(run: unknown): void {
  if (committedRun !== run) return
  committedRun = undefined
  commitSeq++
}

function registerPoll(next: PollRegistration): void {
  // One window renders one chat: a second live registration would attribute
  // reads to the wrong visit.
  if (registration && registration.poll !== next.poll) recordUnexpected('second concurrent RemoteChat poll registration')
  registration = next
}

function unregisterPoll(poll: () => Promise<void>): void {
  if (registration?.poll === poll) registration = undefined
}

function autoPoll(): void { autoPolls++ }

/**
 * Locates the marker's own text node and asks the browser whether that node is
 * CSS-visible, then requires real layout. `body.textContent` matching proves
 * nothing, and a per-element opacity probe misses an ancestor with opacity 0:
 * checkVisibility({ checkOpacity }) walks the ancestor chain. This still says
 * only CSS/layout visible — not screen paint, occlusion or z-order.
 */
type CheckVisibility = (options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean

function markerState(): MarkerState {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.includes(MARKER_TEXT)) continue
    const element = text.parentElement
    if (!element) return { visible: false, reason: 'marker-parent-missing', width: 0, height: 0 }
    const checkVisibility = (element as Element & { checkVisibility?: CheckVisibility }).checkVisibility
    if (typeof checkVisibility !== 'function') return { visible: false, reason: 'marker-check-unavailable', width: 0, height: 0 }
    if (!checkVisibility.call(element, { checkOpacity: true, checkVisibilityCSS: true })) {
      const style = window.getComputedStyle(element)
      return { visible: false, reason: `marker-css-hidden:${style.display}/${style.visibility}/${style.opacity}`, width: 0, height: 0 }
    }
    const rect = element.getBoundingClientRect()
    if (element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) {
      return { visible: false, reason: 'marker-zero-layout', width: rect.width, height: rect.height }
    }
    return { visible: true, reason: 'visible', width: rect.width, height: rect.height }
  }
  return { visible: false, reason: 'marker-node-missing', width: 0, height: 0 }
}

async function beginVisit(target: LiveVisitTarget): Promise<{ visitId: string }> {
  if (root) recordUnexpected('beginVisit while a visit is mounted')
  ledger.begin(target.visitId, performance.now())
  visitTarget = target
  authorizedConnectionId = target.connectionId
  calls = {}
  failed = {}
  commits = 0
  commitMs = 0
  autoPolls = 0
  registration = undefined
  committedRun = undefined
  commitSeq = 0
  const drafts = createComposerDraftStore(new Map())
  const queue = new RemotePromptQueueStore()
  // Setup read, counted with the rest of the mount traffic instead of pre-warming.
  await refreshRemoteCatalog(target.connectionId)
  const container = document.getElementById('root') ?? recordUnexpected('missing fixture root element')
  root = createRoot(container)
  root.render(<Fixture target={target} draftStore={drafts} queueStore={queue} />)
  return { visitId: target.visitId }
}

/**
 * The production flags this visit depends on, copied as they are. A wrong cwd makes the
 * catalog session inactive and Controls then never reads liveRun/traceDelta, so a visit that
 * only checks the context would measure an empty poll and call it a round.
 */
function registrationFlags(): Record<string, unknown> | null {
  const current = registration
  if (!current) return null
  return {
    connectionId: current.connectionId,
    contextKey: current.contextKey,
    context: current.context,
    connected: current.connected,
    catalogReady: current.catalogReady,
    sessionActive: current.sessionActive,
    traceDelta: current.traceDelta,
    diagnostics: current.diagnostics
  }
}

function ready(): { ready: boolean; reason: string; autoPolls: number; flags: Record<string, unknown> | null } {
  const flags = registrationFlags()
  const target = visitTarget
  if (!target) return { ready: false, reason: 'no-visit', autoPolls, flags }
  const current = registration
  if (!current) return { ready: false, reason: 'poll-not-registered', autoPolls, flags }
  if (!current.connected) return { ready: false, reason: 'connection-not-connected', autoPolls, flags }
  if (!current.catalogReady) return { ready: false, reason: 'catalog-not-ready', autoPolls, flags }
  if (current.connectionId !== target.connectionId) return { ready: false, reason: 'connection-mismatch', autoPolls, flags }
  const context = current.context
  if (context.cwd !== target.cwd || context.providerId !== target.providerId) return { ready: false, reason: 'target-mismatch', autoPolls, flags }
  if ((context.agentProfileId ?? '') !== (target.agentProfileId ?? '')) return { ready: false, reason: 'provider-profile-mismatch', autoPolls, flags }
  if ((context.externalSessionId ?? '') !== (target.session.externalSessionId ?? '')) return { ready: false, reason: 'session-mismatch', autoPolls, flags }
  // This lane reads a run the host is executing, so production must mark the session active;
  // an inactive session makes Controls skip liveRun entirely (no liveRun, no traceDelta).
  if (current.sessionActive !== true) return { ready: false, reason: 'session-not-active', autoPolls, flags }
  if (current.traceDelta !== true) return { ready: false, reason: 'trace-delta-unavailable', autoPolls, flags }
  return { ready: true, reason: 'ready', autoPolls, flags }
}

async function round(): Promise<LiveRoundSample> {
  const target = requireVisit()
  const current = registration ?? recordUnexpected('round without a registered poll')
  const readiness = ready()
  if (!readiness.ready) recordUnexpected(`round while not ready: ${readiness.reason}`)
  const index = ledger.state().rounds + 1
  // Everything read between mount and the first round is setup traffic, reported
  // separately and never silently dropped.
  if (index === 1) ledger.recordMount({ calls: { ...calls }, failed: { ...failed } })
  const beforeCalls = { ...calls }
  const beforeFailed = { ...failed }
  const commitsBefore = commits
  const commitMsBefore = commitMs
  const autoBefore = autoPolls
  const pollStarted = performance.now()
  await current.poll()
  const pollMs = performance.now() - pollStarted
  const settleStarted = performance.now()
  // Two frames are DOM settlement for the checks below, not screen paint.
  await nextFrame()
  await nextFrame()
  const settleMs = performance.now() - settleStarted
  const markerStarted = performance.now()
  const marker = markerState()
  const markerCheckMs = performance.now() - markerStarted
  const roundCalls = callDelta(beforeCalls, calls)
  const roundFailed = callDelta(beforeFailed, failed)
  const violations = roundViolations({ calls: roundCalls, failed: roundFailed })
  // A stale view plus a marker is not a successful round: the committed view must
  // exist and must be this visit's host-local run.
  const run = committedRun
  if (!run || typeof run !== 'object') violations.push('committed_run_missing')
  else if ((run as { runId?: unknown }).runId !== target.nativeRunId) violations.push('committed_run_mismatch')
  else if (!Array.isArray((run as { items?: unknown }).items)) violations.push('committed_run_items_missing')
  if (!marker.visible) violations.push(`marker:${marker.reason}`)
  const sample: LiveRoundSample = {
    round: index,
    pollMs,
    settleMs,
    markerCheckMs,
    marker,
    commits: commits - commitsBefore,
    commitMs: commitMs - commitMsBefore,
    autoPolls: autoPolls - autoBefore,
    calls: roundCalls,
    failed: roundFailed,
    violations: [...violations].sort()
  }
  ledger.recordRound(sample, run)
  if (sample.violations.length > 0) throw new Error(`concurrency_trace_live_round_rejected: ${sample.violations.join(', ')}`)
  return sample
}

function endVisit(): LiveVisitSummary {
  requireVisit()
  const current = root
  root = undefined
  // A real unmount: effect cleanups release the committed run and drop the poll
  // registration before the next visit starts.
  current?.unmount()
  if (registration) recordUnexpected('poll registration survived unmount')
  if (committedRun !== undefined) recordUnexpected('committed run survived unmount')
  const summary = ledger.end(performance.now())
  visitTarget = undefined
  authorizedConnectionId = undefined
  return summary
}

function takeViews(): readonly unknown[] { return ledger.takeViews() }
function releaseViews(): number { return ledger.releaseViews() }
function state(): unknown {
  const run = committedRun
  const current = ready()
  // No IPC/wire byte totals: the renderer never re-serializes a response to
  // measure it, so this number is unavailable rather than estimated.
  return {
    unexpected,
    calls,
    failed,
    autoPolls,
    capturedTimers: capturedTimers.size,
    ipcBytes: 'unavailable',
    // The real readiness flags and the production catalog strings, so a mismatch is visible
    // instead of surfacing as a round that only read intents.
    flags: registrationFlags(),
    readiness: { ready: current.ready, reason: current.reason },
    committedRun: run && typeof run === 'object' ? { runId: (run as { runId?: unknown }).runId ?? null, commitSeq } : null,
    marker: markerState(),
    ledger: ledger.state()
  }
}

function Fixture({ target, draftStore: drafts, queueStore: queue }: { target: LiveVisitTarget; draftStore: ReturnType<typeof createComposerDraftStore>; queueStore: RemotePromptQueueStore }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  return <Profiler id="concurrency-trace-live" onRender={(_id, _phase, actualDuration) => { commits++; commitMs += actualDuration }}>
    <RemoteChat connectionId={target.connectionId} cwd={target.cwd} session={target.session}
      draftStore={drafts} queueStore={queue}
      onDraftInput={() => recordUnexpected('onDraftInput (read-only visit)')}
      scrollRef={scrollRef} textareaRef={textareaRef} renderLocationPicker={() => null}
      onSessionAdopted={() => recordUnexpected('onSessionAdopted (read-only visit)')}
      surface={{ target: null, state: createRightSurfaceState(), onAction: () => {} }} />
  </Profiler>
}

;(window as unknown as Record<string, unknown>)[LIVE_DRIVER_KEY] = {
  registerPoll, unregisterPoll, autoPoll, publishRun, releaseRun,
  beginVisit, ready, round, endVisit, takeViews, releaseViews, state
}
