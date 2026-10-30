import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationSummary } from '@shared/conversation-api'
import { SIDE_CHAT_DEFAULT_TITLE } from '@shared/conversation'
import type { DetectedAgent } from './env'
import { SIDE_CHAT_COPY } from './constants/side-chat-copy'
import { providerContextOf, requestedAgentId, useSideChatInstance } from './hooks/useSideChatInstance'
import { readSideChatPreferences, writeSideChatPreference } from './side-chat-preferences'
import { SideChatHeader, SideChatSurface } from './components/SideChatSurface'
import { SideChatSnapshotViewer } from './components/SideChatSnapshotViewer'

const memoryStorage = () => {
  const rows = new Map<string, string>()
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value) }
  }
}

const agent = (id: string): DetectedAgent => ({
  id, name: id, bin: id, path: `/bin/${id}`
})

const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'child-1', cwd: '/repo', title: SIDE_CHAT_DEFAULT_TITLE, turnCount: 0, revision: 1,
  sideChat: {
    source: { kind: 'conversation', conversationId: 'parent-1' },
    parentTitleAtCapture: '主会话标题',
    initialTarget: { providerId: 'codex' },
    throughOrdinal: 7,
    throughRunId: 'run-7',
    capturedAt: Date.UTC(2026, 0, 2, 3, 4),
    prefixFingerprint: 'fingerprint',
    messageCount: 12
  },
  ...overrides
})

/** Renders the real controller so its public control surface can be inspected. */
function Probe({ conversation, agents }: { conversation: ConversationSummary; agents: DetectedAgent[] }) {
  const instance = useSideChatInstance({ conversation, agents })
  const props = instance.chatProps
  const surface: Record<string, string | null> = {
    selectedAgentId: props.selectedAgentId,
    provider: props.runControlCatalog.models.length === 0 ? 'empty' : 'models',
    permissionMode: props.runControls.permissionMode,
    model: props.runControls.model?.id ?? null,
    addPi: typeof props.onAddPiAgent,
    removePi: typeof props.onRemovePiAgent,
    rescan: typeof props.onRescan,
    retryDetection: typeof props.onRetryDetection,
    detectionIssue: props.detectionIssue ?? null,
    selectAgentSame: props.onSelectAgent === props.onSelectAgent ? 'stable' : 'unstable',
    blocked: instance.blockedReason ?? null,
    sendBlocked: props.sendBlockedReason ?? null
  }
  return <p data-probe={JSON.stringify(surface)} />
}

function probe(conversation: ConversationSummary, agents: DetectedAgent[]): Record<string, string | null> {
  const html = renderToStaticMarkup(<Probe conversation={conversation} agents={agents} />)
  const match = /data-probe="([^"]+)"/.exec(html)
  if (!match) throw new Error('probe did not render')
  return JSON.parse(match[1].replace(/&quot;/g, '"')) as Record<string, string | null>
}

describe('side chat runtime seeding', () => {
  it('seeds from the persisted source target, not the parent selection', () => {
    expect(requestedAgentId({ conversation: summary(), agents: [agent('claude'), agent('codex')] }))
      .toEqual({ agentId: 'codex', availability: 'available' })
  })

  it('prefers a named Pi profile over a bare provider id', () => {
    const child = summary({ sideChat: { ...summary().sideChat!, initialTarget: { providerId: 'pi', agentProfileId: 'pi:work' } } })
    expect(requestedAgentId({ conversation: child, agents: [agent('claude'), agent('pi'), agent('pi:work')] }))
      .toEqual({ agentId: 'pi:work', availability: 'available' })
  })

  it('keeps the requested Provider when it is missing instead of picking another', () => {
    // Persisted target names a Pi profile that no longer exists; Claude is installed.
    const child = summary({ sideChat: { ...summary().sideChat!, initialTarget: { providerId: 'pi', agentProfileId: 'pi:deleted' } } })
    expect(requestedAgentId({ conversation: child, agents: [agent('claude')] }))
      .toEqual({ agentId: 'pi:deleted', availability: 'unavailable' })
    const rendered = probe(child, [agent('claude')])
    expect(rendered.selectedAgentId).toBe('pi:deleted')
    expect(rendered.blocked).toBe(SIDE_CHAT_COPY.providerUnavailable('pi:deleted'))
    expect(rendered.sendBlocked).toBe(SIDE_CHAT_COPY.providerUnavailable('pi:deleted'))
    expect(rendered.addPi).toBe('undefined')
    expect(rendered.removePi).toBe('undefined')
  })

  it('blocks an unavailable Qoder instead of falling back to an installed Claude', () => {
    const child = summary({ sideChat: { ...summary().sideChat!, initialTarget: { providerId: 'qoder', permissionMode: 'full_access' } } })
    const rendered = probe(child, [agent('claude')])
    expect(rendered.selectedAgentId).toBe('qoder')
    expect(rendered.permissionMode).toBe('full_access')
    expect(rendered.blocked).toBe(SIDE_CHAT_COPY.providerUnavailable('qoder'))
    // Reading is not "installed": nothing is claimed before the agent list arrives.
    expect(probe(child, []).blocked).toBe(SIDE_CHAT_COPY.providerReading)
  })

  it('honours an explicit later choice but still never invents one', () => {
    const storage = memoryStorage()
    writeSideChatPreference('child-1', { agentId: 'claude', permissionMode: 'default' }, storage)
    const child = summary({ sideChat: { ...summary().sideChat!, initialTarget: { providerId: 'codex' } } })
    expect(requestedAgentId({ conversation: child, saved: readSideChatPreferences(storage).get('child-1'), agents: [agent('claude')] }))
      .toEqual({ agentId: 'claude', availability: 'available' })
    const saved = readSideChatPreferences(storage).get('child-1')
    const deleted = { ...saved!, agentId: 'pi:gone', permissionMode: 'default' as const }
    expect(requestedAgentId({ conversation: child, saved: deleted, agents: [agent('claude')] }))
      .toEqual({ agentId: 'pi:gone', availability: 'unavailable' })
  })

  it('rejects an unknown agent id instead of guessing Claude', () => {
    expect(providerContextOf('pi:work', '/repo')).toEqual({ providerId: 'pi', agentProfileId: 'pi:work', cwd: '/repo' })
    expect(providerContextOf('codex', '/repo')).toEqual({ providerId: 'codex', cwd: '/repo' })
    expect(providerContextOf('', '/repo')).toBeUndefined()
    expect(providerContextOf('not-a-provider', '/repo')).toBeUndefined()
  })
})

describe('side chat instance control surface', () => {
  it('exposes no host agent-install, PATH-rescan or detection action', () => {
    // Runtime proof, not only the Omit type: the instance builds its own prop object and
    // these keys are absent, so a child picker cannot mutate the host's global agent.
    const rendered = probe(summary(), [agent('claude'), agent('codex')])
    expect(rendered.addPi).toBe('undefined')
    expect(rendered.removePi).toBe('undefined')
    expect(rendered.rescan).toBe('undefined')
    expect(rendered.retryDetection).toBe('undefined')
    expect(rendered.detectionIssue).toBeNull()
  })

  it('does not accept the host prop bag at all', () => {
    // @ts-expect-error - the surface takes only readonly agents plus explicit host decisions
    const forbidden: React.ComponentProps<typeof SideChatSurface> = { host: { onAddPiAgent: () => undefined } }
    expect(forbidden).toBeDefined()
  })
})

describe('side chat surface copy and provenance', () => {
  it('shows the default title, the captured source title and the frozen boundary', () => {
    const html = renderToStaticMarkup(<SideChatHeader title={SIDE_CHAT_DEFAULT_TITLE} summary={summary().sideChat} cwd="/repo"
      snapshotOpen={false} onToggleSnapshot={() => undefined} onClose={() => undefined} />)
    expect(html).toContain(SIDE_CHAT_DEFAULT_TITLE)
    expect(html).toContain('主会话标题')
    expect(html).toContain(SIDE_CHAT_COPY.snapshotLine(7))
    expect(html).toContain(SIDE_CHAT_COPY.snapshotDetail)
    // The workspace moved to the composer's readonly label: keeping it in this row truncated
    // the captured parent title to a couple of characters in a narrow pane.
    expect(html).toContain('data-side-chat-workspace="/repo"')
    expect(html).not.toContain(SIDE_CHAT_COPY.workspaceReadonly('repo'))
  })

  it('gives the captured parent the row instead of a shrunken workspace', () => {
    const html = renderToStaticMarkup(<SideChatHeader title={SIDE_CHAT_DEFAULT_TITLE} summary={summary().sideChat} cwd="/repo"
      snapshotOpen onToggleSnapshot={() => undefined} onClose={() => undefined} />)
    expect(html).toContain('data-side-chat-parent-title="true">主会话标题')
    expect(html).toContain('aria-expanded="true"')
  })

  it('renders the main view without a second title or a tab close action', () => {
    // The main pane already prints the conversation title and leaves by navigation, so the
    // header keeps only what the body cannot say: the captured source and the snapshot action.
    const html = renderToStaticMarkup(<SideChatHeader title="我自己起的名字" summary={summary().sideChat} cwd="/repo"
      variant="main" snapshotOpen={false} onToggleSnapshot={() => undefined} />)
    expect(html).not.toContain('我自己起的名字')
    expect(html).not.toContain(SIDE_CHAT_COPY.surfaceClose)
    expect(html).toContain('主会话标题')
    expect(html).toContain(SIDE_CHAT_COPY.snapshotDetail)
  })

  it('never reuses the source title as the child title', () => {
    const html = renderToStaticMarkup(<SideChatHeader title="我自己起的名字" summary={summary().sideChat} cwd="/repo"
      snapshotOpen={false} onToggleSnapshot={() => undefined} onClose={() => undefined} />)
    expect(html).toContain('我自己起的名字')
    expect(html).not.toContain(`>${SIDE_CHAT_DEFAULT_TITLE}<`)
  })
})

describe('snapshot viewer frame', () => {
  it('labels the frozen source with capture time and message count before any page arrives', () => {
    const html = renderToStaticMarkup(<SideChatSnapshotViewer conversationId="child-1" summary={summary().sideChat!}
      onClose={() => undefined} />)
    expect(html).toContain('主会话标题')
    expect(html).toContain(SIDE_CHAT_COPY.snapshotMessageCount(12))
    expect(html).toContain(SIDE_CHAT_COPY.snapshotLine(7))
    expect(html).toContain('data-side-chat-snapshot="child-1"')
    expect(html).not.toContain('data-snapshot-state="complete"')
  })
})

/** Global renderer state the child controller must not consult by itself. */
describe('side chat controller construction touches no global host state', () => {
  const spies = {
    addPiProfile: vi.fn(async () => null),
    removePiProfile: vi.fn(async () => true as const),
    runControls: vi.fn(async () => { throw new Error('must not read on mount') })
  }
  beforeEach(() => {
    vi.stubGlobal('window', { scry: {
      addPiProfile: spies.addPiProfile,
      removePiProfile: spies.removePiProfile,
      runControls: spies.runControls
    } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const spy of Object.values(spies)) spy.mockClear()
  })

  it('installs, rescans and reads nothing until an explicit control interaction', () => {
    const rendered = probe(summary(), [agent('claude'), agent('codex')])
    expect(rendered.selectedAgentId).toBe('codex')
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
  })
})
