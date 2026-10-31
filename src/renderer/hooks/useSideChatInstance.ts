import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderContext } from '@shared/provider'
import type { ConversationSummary } from '@shared/conversation-api'
import { providerIdForAgentId, type AgentModelRef, type AgentPermissionMode, type AgentRunControlCatalog,
  type AgentRunControls } from '@shared/runtime'
import type { Turn } from '../format'
import type { WorkspaceFileTarget } from '../workspace-links'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import { createRunControlCatalogReader } from '../side-chat-catalog'
import { readSideChatPreferences, writeSideChatPreference, type SideChatPreferences } from '../side-chat-preferences'
import { readSideChatViewPosition, rememberSideChatViewPosition, sideChatViewPosition } from '../side-chat-view-state'
import { useChatNavigation } from './useChatNavigation'
import { useDiffInspector } from './useDiffInspector'
import type { DiffReviewSelection } from './useDiffReviewSelection'
import { contextKey, fallbackRunControlCatalog, readRunControlCatalogCache } from './integration-model'

type ChatProps = ConversationHostChatProps
type Availability = 'available' | 'unavailable' | 'reading'

/** Provider context of one agent id; an unknown id has no context instead of a guessed one. */
export function providerContextOf(agentId: string, cwd: string): ProviderContext | undefined {
  const providerId = providerIdForAgentId(agentId)
  if (!providerId) return undefined
  return { providerId, ...(providerId === 'pi' ? { agentProfileId: agentId } : {}), cwd }
}

/**
 * The Provider this child was asked to run, never a substitute for it.
 *
 * A side chat records the Provider/Profile requested at creation and the user's own
 * last explicit choice. If that one is missing right now the child stays on it and
 * blocks sending: switching to whatever happens to be installed would silently change
 * Provider and could carry `full_access` or a model id to a different runtime.
 */
export function requestedAgentId({
  conversation, saved, agents
}: {
  conversation: ConversationSummary
  saved?: SideChatPreferences
  agents: readonly { id: string }[]
}): { agentId: string; availability: Availability } {
  const target = conversation.sideChat?.initialTarget
  const agentId = saved?.agentId ?? target?.agentProfileId ?? target?.providerId ?? ''
  if (!agentId) return { agentId, availability: 'unavailable' }
  if (agents.length === 0) return { agentId, availability: 'reading' }
  return { agentId, availability: agents.some(agent => agent.id === agentId) ? 'available' : 'unavailable' }
}

/**
 * Instance-owned controller for one side chat.
 *
 * The child gets its own refs, selection, navigation, errors, attachments and diff
 * evidence. Nothing here writes another surface's state: sharing is limited to the
 * readonly agent list, the cached capability catalogs and an explicit `onOpenFile`.
 * Mounting a side chat starts no Provider query; a capability read happens only when
 * the user opens or changes a runtime control, and the send still revalidates model,
 * auth and trust in main.
 */
export function useSideChatInstance({ conversation, agents, onOpenFile, renderLocationPicker, autoFocusComposer }: {
  conversation: ConversationSummary
  agents: ChatProps['agents']
  onOpenFile?: (target: WorkspaceFileTarget) => void
  /** Readonly shared-workspace label replaces the folder picker; the workspace is fixed. */
  renderLocationPicker?: ChatProps['renderLocationPicker']
  /**
   * Focus the composer when this view first appears because the user just created it.
   * A tab switch does not ask for it, so keyboard tab navigation keeps its own focus.
   */
  autoFocusComposer?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const frozenTarget = conversation.sideChat?.initialTarget
  const saved = useMemo(() => readSideChatPreferences().get(conversation.id), [conversation.id])
  const [selectedAgentId, setSelectedAgentId] = useState(() =>
    requestedAgentId({ conversation, saved, agents }).agentId)
  const availability = useMemo<Availability>(() => {
    if (!selectedAgentId) return 'unavailable'
    if (agents.some(agent => agent.id === selectedAgentId)) return 'available'
    return agents.length === 0 ? 'reading' : 'unavailable'
  }, [agents, selectedAgentId])
  const [runControls, setRunControls] = useState<AgentRunControls>(() => ({
    ...((saved?.model ?? frozenTarget?.model) ? { model: saved?.model ?? frozenTarget?.model } : {}),
    ...((saved?.effort ?? frozenTarget?.effort) ? { effort: saved?.effort ?? frozenTarget?.effort } : {}),
    permissionMode: saved?.permissionMode ?? frozenTarget?.permissionMode ?? 'default'
  }))
  const byAgent = useRef(new Map<string, AgentRunControls>())
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string>()
  const [turns, setTurns] = useState<Turn[]>([])
  /** Whether the mounted body currently shows the newest bounded window of this child. */
  const newestWindow = useRef(true)
  const [diffSelection, setDiffSelection] = useState<DiffReviewSelection | null>(null)
  // One-time seed from the local capability cache: a warm child shows real options
  // immediately and needs no read when the picker opens; a cold child reads on open.
  const seeded = useRef<{ cached?: AgentRunControlCatalog }>()
  if (!seeded.current) {
    const seedContext = providerContextOf(selectedAgentId, conversation.cwd)
    const cached = seedContext ? readRunControlCatalogCache().get(contextKey(seedContext))?.data : null
    seeded.current = { ...(cached ? { cached } : {}) }
  }
  const [catalog, setCatalog] = useState<AgentRunControlCatalog>(() =>
    seeded.current?.cached ?? fallbackRunControlCatalog('default'))
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogReason, setCatalogReason] = useState<string | null>(() =>
    seeded.current?.cached ? null : SIDE_CHAT_COPY.catalogNotRead)
  const mounted = useRef(true)
  const lastPosition = useRef(readSideChatViewPosition(conversation.id))
  const catalogReader = useRef<ReturnType<typeof createRunControlCatalogReader>>()
  if (!catalogReader.current) {
    const reader = createRunControlCatalogReader({
      read: async context => {
        const readControls = window.scry.runControls
        if (typeof readControls !== 'function') throw new Error(SIDE_CHAT_COPY.catalogUnavailable)
        return readControls(context)
      },
      settle: ({ result }) => {
        if (!mounted.current) return
        setCatalogLoading(false)
        if (result.status === 'ready') {
          setCatalog(result.data)
          setCatalogReason(null)
        } else setCatalogReason(result.reason || SIDE_CHAT_COPY.catalogUnavailable)
      }
    })
    const seedContext = providerContextOf(selectedAgentId, conversation.cwd)
    if (seeded.current?.cached && seedContext) reader.markLoaded(contextKey(seedContext))
    catalogReader.current = reader
  }
  /**
   * Remembered position of this child, read once at mount.
   *
   * The value goes to the conversation view so the restore happens in the commit that
   * first shows authoritative turns, instead of a frame that runs before the page exists.
   */
  const [initialViewPosition] = useState(() => readSideChatViewPosition(conversation.id))
  const applyProjection = useCallback((projection: { turns: Turn[]; atNewest: boolean }): void => {
    newestWindow.current = projection.atNewest
    setTurns(projection.turns)
  }, [])
  useEffect(() => {
    mounted.current = true
    const reader = catalogReader.current
    if (autoFocusComposer) {
      // Only a fresh creation moves focus here; switching tabs leaves focus on the tab.
      const frame = requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (textarea && !textarea.disabled) textarea.focus({ preventScroll: true })
      })
      return () => {
        mounted.current = false
        cancelAnimationFrame(frame)
        reader?.cancel()
      }
    }
    return () => {
      mounted.current = false
      reader?.cancel()
    }
  }, [conversation.id])
  useEffect(() => {
    // Persist while the DOM node is alive. React detaches refs before effect cleanup, so
    // reading the element there would save nothing; the last observed position is kept.
    const element = scrollRef.current
    if (!element) return
    let frame = 0
    const save = (): void => {
      frame = 0
      // Virtualized rows are measured before their real heights exist, so a long transcript
      // can briefly report no overflow at all. That is a collapsed measurement, not a reader
      // at the bottom, and recording it would replace a real anchor with a degenerate one.
      if (element.scrollHeight <= element.clientHeight + 8 && element.querySelectorAll('[data-run-id]').length > 4) return
      lastPosition.current = sideChatViewPosition(element, newestWindow.current)
      rememberSideChatViewPosition(conversation.id, lastPosition.current)
    }
    const onScroll = (): void => { if (!frame) frame = requestAnimationFrame(save) }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
      if (lastPosition.current) rememberSideChatViewPosition(conversation.id, lastPosition.current)
    }
  }, [conversation.id])

  const persist = useCallback((agentId: string, controls: AgentRunControls): void => {
    const value: SideChatPreferences = {
      agentId,
      ...(controls.model ? { model: { ...controls.model } } : {}),
      ...(controls.effort ? { effort: controls.effort } : {}),
      permissionMode: controls.permissionMode
    }
    writeSideChatPreference(conversation.id, value)
  }, [conversation.id])
  const context = providerContextOf(selectedAgentId, conversation.cwd)
  /**
   * One coalesced read for the current Provider context, started only by an explicit
   * picker open or control change. An unavailable Provider has no context to read.
   */
  const requestCatalog = useCallback((): void => {
    // A coalesced or already-loaded request reports nothing back, so the loading state
    // follows the answer instead of a dropped request.
    if (!context || !catalogReader.current?.request(context)) return
    setCatalogLoading(true)
    setCatalogReason(SIDE_CHAT_COPY.catalogReading)
  }, [context])

  const selectAgent = useCallback((agentId: string): void => {
    if (agentId === selectedAgentId) return
    byAgent.current.set(selectedAgentId, runControls)
    const restored = byAgent.current.get(agentId) ?? { permissionMode: 'default' as const }
    setSelectedAgentId(agentId)
    setRunControls(restored)
    persist(agentId, restored)
    // Never keep the previous Provider's catalog on screen while the new one is read.
    const nextContext = providerContextOf(agentId, conversation.cwd)
    const nextCached = nextContext ? readRunControlCatalogCache().get(contextKey(nextContext)) : undefined
    setCatalog(nextCached?.data ?? fallbackRunControlCatalog(restored.permissionMode))
    setCatalogReason(nextCached?.data ? SIDE_CHAT_COPY.catalogReading : SIDE_CHAT_COPY.catalogNotRead)
    if (!nextContext) return
    if (catalogReader.current?.request(nextContext)) setCatalogLoading(true)
  }, [conversation.cwd, persist, runControls, selectedAgentId])
  const changeControls = useCallback((change: (current: AgentRunControls) => AgentRunControls): void => {
    const next = change(runControls)
    setRunControls(next)
    persist(selectedAgentId, next)
  }, [persist, runControls, selectedAgentId])
  const setRunModel = useCallback((model?: AgentModelRef): void => {
    changeControls(current => ({ ...current, model }))
  }, [changeControls])
  const setRunEffort = useCallback((effort?: string): void => {
    changeControls(current => ({ ...current, effort }))
  }, [changeControls])
  const setPermissionMode = useCallback((mode: AgentPermissionMode): void => {
    changeControls(current => ({ ...current, permissionMode: mode }))
  }, [changeControls])
  // A side chat shares the frozen source workspace; it may not move to another one.
  const refuseWorkspaceChange = useCallback((): void => { setNotice(SIDE_CHAT_COPY.workspaceFixed) }, [])

  const blockedReason = availability === 'available' ? undefined
    : availability === 'reading' ? SIDE_CHAT_COPY.providerReading
      : SIDE_CHAT_COPY.providerUnavailable(selectedAgentId || SIDE_CHAT_COPY.providerUnknown)

  const navigation = useChatNavigation(scrollRef, true, turns.length, conversation.id)
  const diff = useDiffInspector({
    cwd: conversation.cwd, summaryCwd: conversation.cwd, summary: null, summaryRefreshing: false,
    turns, selection: diffSelection, select: setDiffSelection, enabled: false, refreshKey: 0
  })
  const chatProps: ChatProps = {
    selectedId: selectedTurnId,
    scrollRef,
    textareaRef,
    recent: [],
    agents,
    selectedAgentId,
    runControls,
    runControlCatalog: catalog,
    runControlsLoading: catalogLoading,
    runControlsReason: catalogReason,
    // The workspace is fixed by the frozen source, so the picker is replaced by a
    // readonly label; these only ever report why, never silently do nothing.
    onChooseFolder: refuseWorkspaceChange,
    onPickRecent: refuseWorkspaceChange,
    onRemoveRecent: refuseWorkspaceChange,
    renderLocationPicker,
    // This instance never opens a slash menu and never queues while busy, so these
    // handlers are unreachable; the body closes the menu and passes an empty queue.
    onRetrySlash: () => {},
    onPickSlash: () => {},
    onSlashSel: () => {},
    onHideSlash: () => {},
    slashSel: 0,
    onRemoveQueuedPrompt: () => {},
    onSelectAgent: selectAgent,
    onRunModel: setRunModel,
    onRunEffort: setRunEffort,
    onPermissionMode: setPermissionMode,
    // Opening the model/effort picker is the explicit interaction that reads capability
    // data; a cold child therefore still gets selectable options without a mount probe.
    onOpenRunControls: requestCatalog,
    onSelect: event => setSelectedTurnId(event.id),
    onOpenDiff: (turn, _snapshot, path) =>
      setDiffSelection({ scope: 'turn', runId: turn.runId, ...(path ? { initialPath: path } : {}) }),
    onOpenFile,
    focusedTurnRunId: navigation.focusedTurnRunId,
    scrollNavigation: navigation,
    agentScopeLabel: SIDE_CHAT_COPY.providerControls,
    ...(blockedReason ? { sendBlockedReason: blockedReason } : {})
  }

  return {
    chatProps, turns, applyProjection, notice, blockedReason, initialViewPosition,
    diff, diffSelection, closeDiff: () => setDiffSelection(null)
  }
}
