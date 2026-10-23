// Measurement-only renderer for scripts/remote-trace-profile.mjs (batch E).
// Mounts the production RemoteChat against a hidden Electron main that runs the
// real desktop host reader + DesktopRemoteClient. Periodic timers are captured so
// the profile driver decides when each RemoteChat poll happens.
import { Profiler, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteChat } from '../../src/renderer/components/RemoteChat'
import { createComposerDraftStore } from '../../src/renderer/composer-drafts'
import { RemotePromptQueueStore } from '../../src/renderer/remote-prompt-queue'
import { createRightSurfaceState } from '../../src/renderer/right-surface'
import { refreshRemoteCatalog } from '../../src/renderer/hooks/useRemoteCatalogs'
import '../../src/renderer/styles.css'
import '../../src/renderer/codex-alignment.css'

interface ProfileHost {
  info(): Promise<{ connectionId: string; runId: string; cwd: string; session: string }>
  call(method: string, ...args: unknown[]): Promise<{ ok: true; value: unknown; ms: number; bytes: number } | { ok: false; error: string; ms: number }>
}
const profileHost = (window as unknown as { profileHost: ProfileHost }).profileHost

async function main(): Promise<void> {
const info = await profileHost.info()
// Periodic polling is driven explicitly; keep sub-second timers (rAF fallbacks, debounces) native.
const nativeSetInterval = window.setInterval.bind(window)
const nativeClearInterval = window.clearInterval.bind(window)
const captured = new Set<number>()
let nextTimer = 1_000_000
window.setInterval = ((callback: TimerHandler, delay?: number, ...rest: unknown[]) => {
  if ((delay ?? 0) >= 1000) { const id = ++nextTimer; captured.add(id); return id }
  return nativeSetInterval(callback, delay, ...rest)
}) as typeof window.setInterval
window.clearInterval = ((id?: number) => { if (id === undefined || !captured.delete(id)) nativeClearInterval(id) }) as typeof window.clearInterval

const counters = { commits: 0, commitMs: 0, traceCalls: 0, traceMs: 0, traceBytes: 0, traceErrors: 0, unexpected: [] as string[] }
const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
  const result = await profileHost.call(method, ...args)
  if (method === 'trace' || method === 'traceDelta') {
    counters.traceCalls++
    counters.traceMs += result.ms
    if (result.ok) counters.traceBytes += result.bytes
    else counters.traceErrors++
  }
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const connection = { id: info.connectionId, label: 'Profile host', hostId: 'profile-host', anchorSHA256: 'profile-anchor',
  ssh: { hostname: 'profile.invalid', username: 'profile', port: 22 }, state: 'connected', expiresAt: 4_102_444_800_000 }
const desktopRemote: Record<string, unknown> = {
  list: async () => [connection],
  catalog: () => call('catalog'),
  history: async () => ({ historyScope: 'session', turns: [], hasOlder: false, source: 'trace_archive', status: 'available' }),
  intents: async () => [],
  liveRun: async () => ({ runId: info.runId, origin: 'mac', state: 'running', scryRunId: info.runId }),
  commands: async () => ({ commands: [] }),
  trace: (_id: string, ...args: unknown[]) => call('trace', ...args),
  traceDelta: (_id: string, ...args: unknown[]) => call('traceDelta', ...args)
}
const unexpected = (name: string) => async () => { counters.unexpected.push(name); throw new Error(`profile bridge does not implement ${name}`) }
const scry = new Proxy({ desktopRemote: new Proxy(desktopRemote, { get: (target, name: string) => target[name] ?? unexpected(`desktopRemote.${name}`) }) } as Record<string, unknown>, {
  get: (target, name: string) => target[name] ?? (name.startsWith('on') ? () => () => {} : unexpected(name))
})
;(window as unknown as { scry: unknown }).scry = scry

type PollTrigger = () => Promise<void> | void
const polls = (window as unknown as { __visibilityPolls: Map<string, PollTrigger> }).__visibilityPolls = new Map()
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
;(window as unknown as { __profilePoll: () => Promise<unknown> }).__profilePoll = async () => {
  const trigger = [...polls].find(([key]) => key.includes(info.cwd) && key.includes('"providerId":"claude"'))?.[1]
  if (!trigger) throw new Error(`RemoteChat poll is not registered: ${JSON.stringify([...polls.keys()])}`)
  const before = { ...counters }
  const started = performance.now()
  await trigger()
  await nextFrame()
  await nextFrame()
  return {
    commits: counters.commits - before.commits, commitMs: counters.commitMs - before.commitMs,
    traceCalls: counters.traceCalls - before.traceCalls, traceMs: counters.traceMs - before.traceMs,
    traceBytes: counters.traceBytes - before.traceBytes, traceErrors: counters.traceErrors - before.traceErrors,
    wallMs: performance.now() - started,
    pollIntervalMs: (window as unknown as { __profilePollInterval?: number }).__profilePollInterval ?? null
  }
}
;(window as unknown as { __profileState: () => unknown }).__profileState = () => ({
  unexpected: counters.unexpected,
  run: (window as unknown as { __profileActiveRun?: unknown }).__profileActiveRun ?? null,
  pollError: document.querySelector('[role="alert"]')?.textContent ?? null
})

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  return <Profiler id="remote-chat" onRender={(_id, _phase, actualDuration) => { counters.commits++; counters.commitMs += actualDuration }}>
    <RemoteChat connectionId={info.connectionId} cwd={info.cwd}
      session={{ sessionId: 'profile-session', externalSessionId: info.session, providerId: 'claude', cwd: info.cwd, label: 'Profile session', ts: 1_800_000_000_000, isActive: true }}
      draftStore={createComposerDraftStore(new Map())} queueStore={new RemotePromptQueueStore()} onDraftInput={() => {}}
      scrollRef={scrollRef} textareaRef={textareaRef} renderLocationPicker={() => null} onSessionAdopted={() => {}}
      surface={{ target: null, state: createRightSurfaceState(), onAction: () => {} }} />
  </Profiler>
}
await refreshRemoteCatalog(info.connectionId)
createRoot(document.getElementById('root')!).render(<Fixture />)
}
void main().catch((error) => { console.error('remote trace profile fixture failed', error); throw error })
