// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { providerIdForAgentId, runtimeProviderForAgentId } from '@shared/runtime'
import type { AgentInputAttachment, AgentModelRef, AgentPermissionMode, AgentQuestionResponse, AgentRunControlCatalog, AgentRunControls } from '@shared/runtime'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import { createPortal } from 'react-dom'
import { RightSurfacePanel } from './RightSurfacePanel'
import { OverviewPanel } from './OverviewPanel'
import { WorkspacePanel, workspaceReferenceToken, type WorkspaceOpenRequest } from './WorkspacePanel'
import { SourceControlPanel } from './SourceControlPanel'
import { AgentsSurface } from './AgentsSurface'
import { TurnDiffReviewPanel } from './TurnDiffReviewPanel'
import { resolveTurnDiffReview, sessionNetDiffReview } from '../turn-diff'
import { createRemoteWorkbench } from '../remote-workbench'
import { chatBottomStickinessAfterScroll, observeChatBottomLayout, scrollChatToBottomIfNeeded } from '../chat-scroll'
import type { RightSurfaceAction, RightSurfaceState } from '../right-surface'
import type {
  DesktopRemoteContext,
  DesktopRemoteHistory,
  DesktopRemoteIntent,
  DesktopRemoteRunStatus,
  DesktopRemoteLiveRun,
  RemoteProviderRef,
  RemoteSessionRef
} from '@shared/desktop-remote'
import type { DetectedAgent } from '../env'
import type { Turn } from '../format'
import {
  attachmentsAfterSuccessfulSubmit,
  clipboardAttachmentToDraft,
  fileToDraftAttachment,
  inputAttachments,
  updateComposerDraft,
  type ComposerDraftAttachment,
  type ComposerDraftStore
} from '../composer-drafts'
import { QUEUE_COPY, REMOTE_ATTACHMENTS_COPY, REMOTE_SESSION_COPY } from '../constants/copy'
import { RemotePromptQueueStore, remoteQueueKey } from '../remote-prompt-queue'
import type { SlashCmd } from '@shared/trace'
import { refreshDesktopConnections, useDesktopConnections } from '../hooks/useDesktopConnections'
import { refreshRemoteCatalog, useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { useVisibilityPolling } from '../hooks/useVisibilityPolling'
import { mergeRemoteTrace, type RemoteTraceView } from '../remote-trace'
import { ChatView } from './ChatView'
import { bridge, defaultOption, desktopProviderKey, historyTurns, RemoteFiles, shouldQueryUnknownIntent } from './DesktopRemote'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import './desktop-remote.css'
import './remote-location.css'

const TerminalSurface = lazy(() => import('./TerminalSurface').then((module) => ({ default: module.TerminalSurface })))
const EMPTY_DRAFT_ATTACHMENTS: ComposerDraftAttachment[] = []
// Delta-capable hosts report "no new trace events"; only then does the poll
// back off (1.5 s → 3 s → 5 s). Any change, status change or user action resumes 1.5 s.
const POLL_MS = 1500
const QUIET_POLL_MAX_MS = 5000
// Poll answers are freshly decoded objects. Keeping the shown value when the
// content is equal lets React skip a whole-transcript render on quiet polls.
function keepIfEqual<T>(next: T): (current: T) => T {
  return (current) => current === next || JSON.stringify(current) === JSON.stringify(next) ? current : next
}

export function remoteDraftKey(connectionId: string, cwd: string, externalSessionId?: string): string {
  return JSON.stringify(['remote', connectionId, cwd, externalSessionId ?? 'new'])
}

// Remote Provider ids are a fixed set without ':', so `${id}:${profile}` is injective.
export function remoteAgentId(provider: Pick<RemoteProviderRef, 'id' | 'agentProfileId'>): string {
  return provider.agentProfileId ? `${provider.id}:${provider.agentProfileId}` : provider.id
}

// The host's labels describe the host ("本机完全访问" means the host user). Viewed
// from this Mac that wording is wrong, so name the executing host explicitly.
export function remotePermissionOption(option: { id: string; label: string; description?: string }, host: string): AgentRunControlCatalog['permissions'][number] {
  const label = option.label.replace(/^本机/, '')
  return {
    id: option.id as AgentPermissionMode,
    label: `${label} · ${host}`,
    description: option.id === 'full_access'
      ? `跳过审批；Agent 以 ${host} 上的用户权限运行`
      : option.description ?? `在 ${host} 上运行`
  }
}

export function remoteRunControlCatalog(provider: RemoteProviderRef | undefined, host: string): AgentRunControlCatalog {
  if (!provider) return { models: [], permissions: [] }
  return {
    models: (provider.models ?? []).map((model) => ({
      model: { id: model.id, ...(model.providerId ? { providerId: model.providerId } : {}) },
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      efforts: model.efforts ?? provider.efforts ?? []
    })),
    permissions: (provider.permissions ?? []).map((option) => remotePermissionOption(option, host))
  }
}

function initialControls(provider: RemoteProviderRef | undefined): AgentRunControls {
  const model = provider?.models?.find((option) => option.id === provider.modelId) ??
    provider?.models?.find((option) => option.isDefault) ?? provider?.models?.[0]
  return {
    ...(model ? { model: { id: model.id, ...(model.providerId ? { providerId: model.providerId } : {}) } } : {}),
    effort: defaultOption(model?.efforts ?? provider?.efforts),
    permissionMode: (defaultOption(provider?.permissions) ?? 'default') as AgentPermissionMode
  }
}

export function remoteControlsValid(provider: RemoteProviderRef | undefined, controls: AgentRunControls): boolean {
  if (!provider?.available) return false
  const model = controls.model
    ? provider.models?.find((option) => option.id === controls.model?.id && option.providerId === controls.model?.providerId)
    : provider.models?.find((option) => option.id === provider.modelId || option.isDefault)
  if (controls.model && !model) return false
  if (controls.effort && !(model?.efforts ?? provider.efforts ?? []).some((option) => option.id === controls.effort)) return false
  return provider.permissions?.length
    ? provider.permissions.some((option) => option.id === controls.permissionMode)
    : controls.permissionMode === 'default'
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('desktop_session_operation_unknown') ? REMOTE_SESSION_COPY.operationUnknown : message
}

export interface RemoteChatProps {
  connectionId: string
  cwd: string
  session?: RemoteSessionRef
  draftStore: ComposerDraftStore
  queueStore: RemotePromptQueueStore
  onDraftInput: (key: string, value: string) => void
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  renderLocationPicker: (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
  onSessionAdopted: (externalSessionId: string, provider: RemoteProviderRef) => void
  surface: {
    target: HTMLElement | null
    state: RightSurfaceState
    scopeId?: string
    retainTerminal?: boolean
    onDirtyChange?: (dirty: boolean) => void
    onAction: (action: RightSurfaceAction) => void
  }
}

export function RemoteChat({
  connectionId,
  cwd,
  session,
  draftStore,
  queueStore,
  onDraftInput,
  scrollRef,
  textareaRef,
  renderLocationPicker,
  onSessionAdopted,
  surface
}: RemoteChatProps) {
  const api = bridge()
  const workbench = useMemo(() => createRemoteWorkbench(api, connectionId, cwd), [api, connectionId, cwd])
  useEffect(() => () => workbench.dispose(), [workbench])
  const [fileRequest, setFileRequest] = useState<WorkspaceOpenRequest | null>(null)
  const [workspaceDirty, setWorkspaceDirty] = useState(false)
  const dispatchSurface = (action: RightSurfaceAction): void => {
    if (action.type === 'close' && action.kind === 'files' && workspaceDirty && !window.confirm('当前文件有未保存修改。放弃修改并继续吗？')) return
    surface.onAction(action)
  }
  const { connections, refreshing: connectionRefreshing, error: readError } = useDesktopConnections()
  const connection = connections.find((item) => item.id === connectionId)
  const connected = !connectionRefreshing && !readError && connection?.state === 'connected'
  const host = connection?.label ?? '远程主机'
  const catalogEntry = useRemoteCatalogs().get(connectionId)
  const catalog = catalogEntry?.catalog
  const catalogReady = catalog !== undefined && !catalogEntry?.stale && !catalogEntry?.error
  const [providerSelection, setProviderSelection] = useState(() => {
    if (session) return desktopProviderKey({ id: session.providerId, agentProfileId: session.agentProfileId })
    const first = catalog?.providers.find((item) => item.available) ?? catalog?.providers[0]
    return first ? desktopProviderKey(first) : ''
  })
  const [sessionId, setSessionId] = useState<string | undefined>(session?.externalSessionId)
  const [controls, setControls] = useState<AgentRunControls>({ permissionMode: 'default' })
  const [selectedProvider, setSelectedProvider] = useState<RemoteProviderRef | undefined>()
  const [selectedProviderContextKey, setSelectedProviderContextKey] = useState<string | undefined>()
  const [providerControlsError, setProviderControlsError] = useState<string | null>(null)
  const [providerControlsLoading, setProviderControlsLoading] = useState(false)
  const [providerControlsRevision, setProviderControlsRevision] = useState(0)
  const [controlsVisible, setControlsVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  useEffect(() => {
    const changed = (): void => setControlsVisible(document.visibilityState === 'visible')
    const focused = (): void => {
      if (document.visibilityState !== 'visible') return
      setControlsVisible(true)
      if (!providerControlsLoading) setProviderControlsRevision(value => value + 1)
    }
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('focus', focused)
    return () => {
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('focus', focused)
    }
  }, [providerControlsLoading])
  const initializedControlsContext = useRef<string | undefined>(undefined)
  const [turns, setTurns] = useState<Turn[]>([])
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [historyEvidence, setHistoryEvidence] = useState<Pick<DesktopRemoteHistory, 'status' | 'reason' | 'hasOlder' | 'before' | 'snapshot'> | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  // The shown run and the host revision it came from; updated synchronously so
  // the next poll continues from exactly what is displayed.
  const traceViewRef = useRef<RemoteTraceView | null>(null)
  const showTrace = useCallback((view: RemoteTraceView | null): void => {
    traceViewRef.current = view
    setActiveRun(view?.run ?? null)
  }, [])
  // Backoff lives outside React state: an interval step must not re-render the transcript.
  const pollIntervalMs = useRef(POLL_MS)
  const applyPollInterval = useRef<(intervalMs: number) => void>(() => {})
  const setPollInterval = useCallback((intervalMs: number): void => {
    pollIntervalMs.current = intervalMs
    applyPollInterval.current(intervalMs)
  }, [])
  const lastPollKey = useRef<string | undefined>(undefined)
  const [runStatus, setRunStatus] = useState<(DesktopRemoteRunStatus & { runId: string }) | null>(null)
  // A host run on this session that this client did not submit.
  const [foreignRun, setForeignRun] = useState<DesktopRemoteLiveRun | null>(null)
  const foreignRunRef = useRef(foreignRun)
  foreignRunRef.current = foreignRun
  const [intents, setIntents] = useState<DesktopRemoteIntent[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [pollFresh, setPollFresh] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [resolvingIntentId, setResolvingIntentId] = useState<string | null>(null)
  const [unknownReceiptError, setUnknownReceiptError] = useState<string | null>(null)
  const generation = useRef(0)
  const openingLatest = useRef(true)
  const followLatest = useRef(true)
  const provider = catalog?.providers.find((item) => desktopProviderKey(item) === providerSelection)
  const providerId = provider?.id ?? ''
  const context = useMemo<DesktopRemoteContext>(() => ({ cwd, providerId, ...(provider?.agentProfileId ? { agentProfileId: provider.agentProfileId } : {}), ...(sessionId ? { externalSessionId: sessionId } : {}) }), [cwd, provider?.agentProfileId, providerId, sessionId])
  const controlContextKey = JSON.stringify([cwd, providerSelection])
  const contextKey = JSON.stringify([providerSelection, sessionId ?? ''])
  const catalogSession = sessionId ? catalog?.sessions.find(item => item.externalSessionId === sessionId && item.cwd === cwd &&
    item.providerId === providerId && (item.agentProfileId ?? '') === (provider?.agentProfileId ?? '')) : undefined
  const sessionActive = catalogSession?.isActive === true
  const traceDelta = catalog?.traceDelta === 1
  const previousContextKey = useRef<string | undefined>()
  const contextGeneration = useRef(0)
  const pollSequence = useRef(0)
  const pollInFlight = useRef<Promise<void> | undefined>(undefined)
  const pollRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const adoptingSession = useRef(false)
  const adoptedIntent = useRef<DesktopRemoteIntent | undefined>()
  const draftKey = remoteDraftKey(connectionId, cwd, sessionId)
  const readInput = () => draftStore.getSnapshot().get(draftKey)?.input ?? ''
  const input = useSyncExternalStore(draftStore.subscribe, readInput, readInput)
  const readDraftAttachments = () => draftStore.getSnapshot().get(draftKey)?.attachments ?? EMPTY_DRAFT_ATTACHMENTS
  const draftAttachments = useSyncExternalStore(draftStore.subscribe, readDraftAttachments, readDraftAttachments)
  const releaseAttachments = useCallback((attachments: readonly ComposerDraftAttachment[]): void => {
    for (const attachment of attachments) {
      if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])
  const updateDraft = useCallback((key: string, update: (current: { input: string; attachments: ComposerDraftAttachment[] }) => { input: string; attachments: ComposerDraftAttachment[] }): void => {
    draftStore.update((drafts) => {
      const result = updateComposerDraft(drafts, key, update)
      for (const evicted of result.evicted) releaseAttachments(evicted.attachments)
      return result.drafts
    })
  }, [draftStore, releaseAttachments])
  const queueKey = remoteQueueKey(draftKey, providerSelection)
  const readQueue = () => queueStore.get(queueKey)
  const queue = useSyncExternalStore(queueStore.subscribe, readQueue, readQueue)
  // 正在输入框里改写的队列条目；编辑期间它跳过自动出队。
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [movedMessageId, setMovedMessageId] = useState<string | null>(null)
  const [slashCmds, setSlashCmds] = useState<SlashCmd[]>([])
  const [slashReason, setSlashReason] = useState<string | null>(null)
  const [slashLoading, setSlashLoading] = useState(false)
  const [slashRevision, setSlashRevision] = useState(0)
  const [slashSel, setSlashSel] = useState(0)
  const [slashHidden, setSlashHidden] = useState(false)
  const submissionInFlight = useRef(false)
  const slashOpen = /^\/[^\s]*$/.test(input) && !slashHidden
  useEffect(() => {
    setSlashSel(0)
    setSlashHidden(false)
  }, [input])
  useEffect(() => {
    setSlashCmds([]); setSlashReason(null)
    if (!connected || !providerId || !slashOpen) { setSlashLoading(false); return }
    let cancelled = false
    setSlashLoading(true)
    void api.commands(connectionId, context).then(result => {
      if (cancelled) return
      setSlashCmds(result.commands)
      setSlashReason(result.reason ?? null)
    }).catch(reason => {
      if (!cancelled) setSlashReason(errorText(reason))
    }).finally(() => { if (!cancelled) setSlashLoading(false) })
    return () => { cancelled = true }
  }, [api, connectionId, connected, context, providerId, slashOpen, slashRevision])
  useEffect(() => {
    if (!connected && !connectionRefreshing) queueStore.pause(queueKey)
  }, [connected, connectionRefreshing, queueKey, queueStore])

  // A new draft picks the host's first available Provider once the catalog arrives.
  // An existing session keeps its recorded Provider even when the host removed it.
  useEffect(() => {
    if (providerSelection || !catalog) return
    const first = catalog.providers.find((item) => item.available) ?? catalog.providers[0]
    if (first) setProviderSelection(desktopProviderKey(first))
  }, [catalog, providerSelection])

  // Changing Provider/profile or session is a different execution context: clear
  // transcript, run state and controls. Session adoption keeps the run it adopted.
  useEffect(() => {
    if (previousContextKey.current === contextKey) return
    previousContextKey.current = contextKey
    openingLatest.current = true
    followLatest.current = true
    contextGeneration.current += 1
    const preserveAdoptedRun = adoptingSession.current
    adoptingSession.current = false
    if (!preserveAdoptedRun) { adoptedIntent.current = undefined; showTrace(null); setRunStatus(null) }
    lastPollKey.current = undefined
    setPollInterval(POLL_MS)
    setForeignRun(null)
    setStatus(null); setError(null); setPollError(null); setHistoryError(null); setHistoryEvidence(null); setTurns([])
  }, [contextKey, setPollInterval, showTrace])
  // Controls are a separate selected-context read. A late response may only
  // publish for the exact Provider/profile/cwd that requested it.
  useEffect(() => {
    if (!connected || !catalogReady || !provider?.available || !providerId) {
      setSelectedProvider(undefined)
      setSelectedProviderContextKey(undefined)
      setProviderControlsError(null)
      setProviderControlsLoading(false)
      return
    }
    if (!controlsVisible) return
    if (catalog?.providerDiscovery !== 2) {
      setSelectedProvider(undefined)
      setSelectedProviderContextKey(undefined)
      setProviderControlsError(null)
      setProviderControlsLoading(false)
      return
    }
    let cancelled = false
    // A same-context observation can refresh without removing known choices.
    // Its timestamp stays visible; failure must discard it, never reuse it as current.
    if (selectedProviderContextKey !== controlContextKey) {
      setSelectedProvider(undefined)
      setSelectedProviderContextKey(undefined)
    }
    setProviderControlsError(null)
    setProviderControlsLoading(true)
    const selectedContext: DesktopRemoteContext = { cwd, providerId, ...(provider.agentProfileId ? { agentProfileId: provider.agentProfileId } : {}) }
    void api.providerControls(connectionId, selectedContext).then((next) => {
      if (!cancelled) {
        setSelectedProvider(next)
        setSelectedProviderContextKey(controlContextKey)
        setProviderControlsLoading(false)
      }
    }).catch((reason) => {
      if (!cancelled) {
        setSelectedProvider(undefined)
        setSelectedProviderContextKey(undefined)
        setProviderControlsError(errorText(reason))
        setProviderControlsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [api, catalogReady, catalog?.providerDiscovery, connected, controlsVisible, connectionId, controlContextKey, cwd, provider?.agentProfileId, provider?.available, provider?.observedAt, provider?.metadataRevision, providerId, providerControlsRevision])

  const controlProvider = catalog?.providerDiscovery !== 2 ? provider
    : selectedProvider && selectedProviderContextKey === controlContextKey && desktopProviderKey(selectedProvider) === providerSelection ? selectedProvider : undefined
  const controlsObserved = useMemo(() => copy.providerControlsObserved(controlProvider?.observedAt, providerControlsLoading), [controlProvider?.observedAt, providerControlsLoading])
  // Initialize once per execution context. Refresh validates rather than silently
  // replacing a user's selected model, effort, or permission with new defaults.
  useEffect(() => {
    if (!controlProvider?.available || initializedControlsContext.current === contextKey) return
    initializedControlsContext.current = contextKey
    setControls(initialControls(controlProvider))
  }, [controlProvider, contextKey])

  useEffect(() => {
    if (!connected || !catalogReady || !providerId || !sessionId) {
      if (!sessionId) { setTurns([]); setHistoryEvidence(null) }
      setHistoryLoading(false)
      return
    }
    const sequence = ++generation.current
    setHistoryError(null)
    setHistoryLoading(true)
    void api.history(connectionId, context).then((history) => {
      if (sequence !== generation.current) return
      setTurns(historyTurns(history))
      setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
    }).catch((reason) => { if (sequence === generation.current) setHistoryError(errorText(reason)) })
      .finally(() => { if (sequence === generation.current) setHistoryLoading(false) })
    return () => { generation.current += 1 }
  }, [api, catalogReady, connectionId, connected, context, historyRevision, providerId, sessionId])

  useEffect(() => {
    if (!connected || !catalogReady) return
    let cancelled = false
    // Returns whether the shown run changed, or undefined when this poll went stale.
    const followTrace = async (runId: string, sequence: number): Promise<boolean | undefined> => {
      const previous = traceViewRef.current?.run.runId === runId ? traceViewRef.current : null
      const knownCount = previous?.run.attachments?.length
      const stale = (): boolean => cancelled || sequence !== pollSequence.current
      if (!traceDelta) {
        const run = await api.trace(connectionId, context, runId, knownCount)
        if (stale()) return undefined
        const merged = mergeRemoteTrace(previous, { kind: 'snapshot', run })
        if (merged.kind === 'applied') showTrace(merged.view)
        return true
      }
      let merged = mergeRemoteTrace(previous, await api.traceDelta(connectionId, context, runId, previous?.cursor, knownCount))
      if (stale()) return undefined
      // A gap, reset or revision discontinuity never patches the shown run: read it whole.
      if (merged.kind === 'gap') merged = mergeRemoteTrace(previous, await api.traceDelta(connectionId, context, runId, undefined, knownCount))
      if (stale()) return undefined
      if (merged.kind === 'gap') throw new Error('remote_trace_gap')
      if (merged.changed) showTrace(merged.view)
      else traceViewRef.current = merged.view
      return merged.changed
    }
    const settlePoll = (key: string, traceChanged: boolean | undefined): void => {
      const quiet = traceChanged === false && key === lastPollKey.current
      lastPollKey.current = key
      setPollInterval(quiet ? Math.min(QUIET_POLL_MAX_MS, pollIntervalMs.current * 2) : POLL_MS)
    }
    const readPoll = async (): Promise<void> => {
      const sequence = ++pollSequence.current
      try {
        const pending = await api.intents(connectionId)
        if (cancelled || sequence !== pollSequence.current) return
        const activeIntent = pending.filter((intent) => intentMatches(intent, context) && intent.runId).sort((left, right) => left.createdAt - right.createdAt).at(-1) ??
          (adoptedIntent.current ? pending.find((intent) => intent.intentId === adoptedIntent.current?.intentId) : undefined)
        if (pending.some(intent => intent.status === 'unknown')) queueStore.pauseConnection(connectionId)
        setIntents(keepIfEqual(pending))
        if (!activeIntent?.runId) {
          setRunStatus(null)
          // Runs started on the host UI, a phone or another desktop leave no
          // receipt here. Ask only while the catalog marks this session active,
          // or to observe the end of a run already being followed.
          const followed = foreignRunRef.current
          const live = context.externalSessionId && (sessionActive || followed) ? await api.liveRun(connectionId, context) : null
          if (cancelled || sequence !== pollSequence.current) return
          setForeignRun(keepIfEqual(live))
          if (followed && live?.runId !== followed.runId) {
            // The followed run left the host's live set; its turn is now history.
            setHistoryRevision((revision) => revision + 1)
            void refreshRemoteCatalog(connectionId)
          }
          let traceChanged: boolean | undefined
          if (live?.scryRunId) {
            traceChanged = await followTrace(live.scryRunId, sequence)
            if (traceChanged === undefined) return
          } else showTrace(null)
          settlePoll(JSON.stringify([pending, live]), traceChanged)
          setPollError(null)
          setPollFresh(true)
          return
        }
        setForeignRun(null)
        const nextStatus = await api.runStatus(connectionId, activeIntent.runId)
        const boundQueueKey = nextStatus.externalSessionId
          ? remoteQueueKey(remoteDraftKey(connectionId, cwd, nextStatus.externalSessionId), providerSelection) : queueKey
        // runStatus may retire the durable receipt. Reconcile App-owned queued
        // work even if navigation cancelled this view while the read was pending.
        if (nextStatus.externalSessionId && !context.externalSessionId) {
          queueStore.migrate(queueKey, boundQueueKey, nextStatus.externalSessionId)
        }
        if (nextStatus.state === 'settled' || nextStatus.state === 'failed') queueStore.settle(boundQueueKey, activeIntent.intentId)
        if (cancelled || sequence !== pollSequence.current) return
        setRunStatus(keepIfEqual<(DesktopRemoteRunStatus & { runId: string }) | null>({ ...nextStatus, runId: activeIntent.runId }))
        if (nextStatus.externalSessionId && !context.externalSessionId && !activeIntent.context.externalSessionId) {
          adoptedIntent.current = activeIntent
          adoptingSession.current = true
          // Text typed while the first run was starting belongs to the adopted session.
          const pendingKey = remoteDraftKey(connectionId, cwd)
          const adoptedKey = remoteDraftKey(connectionId, cwd, nextStatus.externalSessionId)
          draftStore.update((drafts) => {
            const pendingDraft = drafts.get(pendingKey)
            if (!pendingDraft || pendingKey === adoptedKey) return drafts
            const targetDraft = drafts.get(adoptedKey)
            const merged = targetDraft
              ? {
                  input: pendingDraft.input || targetDraft.input,
                  attachments: [...pendingDraft.attachments, ...targetDraft.attachments.filter((candidate) => !pendingDraft.attachments.some((item) => item.id === candidate.id))]
                }
              : pendingDraft
            const next = new Map(drafts)
            next.delete(pendingKey)
            next.set(adoptedKey, merged)
            return next
          })
          setSessionId(nextStatus.externalSessionId)
          if (provider) onSessionAdopted(nextStatus.externalSessionId, provider)
        }
        // Terminal status retires the main-process receipt. Refresh history even
        // if the last trace read fails, before the next poll drops that receipt.
        if (nextStatus.state === 'settled' || nextStatus.state === 'failed') {
          setHistoryRevision((revision) => revision + 1)
          void refreshRemoteCatalog(connectionId)
        }
        let traceChanged: boolean | undefined
        if (nextStatus.scryRunId) {
          traceChanged = await followTrace(nextStatus.scryRunId, sequence)
          if (traceChanged === undefined) return
        } else showTrace(null)
        settlePoll(JSON.stringify([pending, nextStatus]), traceChanged)
        setPollError(null)
        setPollFresh(true)
      } catch (reason) {
        if (!cancelled && sequence === pollSequence.current) { setPollError(errorText(reason)); setPollFresh(false) }
      }
    }
    const poll = (): Promise<void> => {
      if (pollInFlight.current) return pollInFlight.current
      const request = readPoll().finally(() => { pollInFlight.current = undefined })
      pollInFlight.current = request
      return request
    }
    pollRef.current = poll
    return () => {
      cancelled = true
      pollSequence.current += 1
      if (pollRef.current === poll) pollRef.current = undefined
    }
  }, [api, catalogReady, connectionId, connected, context, providerId, providerSelection, queueKey, queueStore, sessionActive, setPollInterval, showTrace, traceDelta])
  applyPollInterval.current = useVisibilityPolling(JSON.stringify([connectionId, context, connected, catalogReady, sessionActive]), () => pollRef.current?.(), POLL_MS, () => {
    pollSequence.current += 1
    setPollFresh(false)
  })

  const runControlCatalog = useMemo(() => remoteRunControlCatalog(controlProvider, host), [host, controlProvider])
  const chosenModel = controlProvider?.models?.find((option) => option.id === controls.model?.id && (option.providerId ?? '') === (controls.model?.providerId ?? ''))
  const availableEfforts = chosenModel?.efforts ?? controlProvider?.efforts
  const validEffort = controls.effort && availableEfforts?.some((option) => option.id === controls.effort) ? controls.effort : undefined
  const validPermissionMode = controlProvider?.permissions?.some((option) => option.id === controls.permissionMode) ? controls.permissionMode : undefined
  const displayTurns = useMemo(() => {
    if (!activeRun) return turns
    const active: Turn = {
      runId: activeRun.runId,
      providerId: activeRun.providerId,
      agentProfileId: activeRun.agentProfileId,
      cwd: activeRun.cwd,
      externalSessionId: activeRun.externalSessionId,
      userText: activeRun.userText,
      attachments: activeRun.attachments,
      items: activeRun.items,
      done: activeRun.done,
      error: activeRun.error,
      errorHint: activeRun.errorHint
    }
    return [...turns.filter((turn) => turn.runId !== activeRun.runId), active]
  }, [activeRun, turns])

  // This mounted remote context owns its scroll intent, independently of the
  // last local/remote session. Follow late Markdown/image layout until the
  // reader deliberately scrolls away from the latest message.
  useEffect(() => {
    const history = scrollRef.current
    if (!history) return
    let previousTop = history.scrollTop
    const onScroll = (): void => {
      const nearLatest = chatBottomStickinessAfterScroll(history, openingLatest.current)
      // A queued programmatic scroll may arrive after content grew. Only an
      // upward move releases following; a larger scrollHeight alone does not.
      if (nearLatest || history.scrollTop < previousTop) followLatest.current = nearLatest
      previousTop = history.scrollTop
    }
    history.addEventListener('scroll', onScroll, { passive: true })
    const unobserve = observeChatBottomLayout(history, () => openingLatest.current || followLatest.current)
    return () => { history.removeEventListener('scroll', onScroll); unobserve?.() }
  }, [scrollRef])
  useLayoutEffect(() => {
    scrollChatToBottomIfNeeded(scrollRef.current, openingLatest.current || followLatest.current)
    if (!openingLatest.current || historyLoading || (sessionId && !historyEvidence && !historyError)) return
    // History arrives asynchronously; retain the opening intent through the
    // first loaded layout and its clamped/queued scroll event.
    const frame = requestAnimationFrame(() => {
      scrollChatToBottomIfNeeded(scrollRef.current, true)
      openingLatest.current = false
      followLatest.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [displayTurns, historyLoading, historyEvidence, historyError, scrollRef, sessionId])

  const currentIntent = intents.filter((intent) => intentMatches(intent, context)).sort((left, right) => left.createdAt - right.createdAt).at(-1) ??
    (adoptedIntent.current ? intents.find((intent) => intent.intentId === adoptedIntent.current?.intentId) : undefined)
  // Unknown is scoped to the connection, not the opened project, Provider or session.
  // A receipt from another context must still fence every composer on this host.
  const unknownReceiptBlocked = intents.some((intent) => intent.status === 'unknown')
  // A previous turn's status is not evidence for the newly submitted receipt.
  const currentRunStatus = runStatus?.runId === currentIntent?.runId ? runStatus : null
  // Same gate as the host ledger: a listed run or an unknown receipt blocks another send.
  const runActive = Boolean(foreignRun) || Boolean(currentIntent && (currentIntent.status === 'unknown' ||
    (currentIntent.runId && currentRunStatus?.state !== 'settled' && currentRunStatus?.state !== 'failed')))
  // Stop/answer go to whichever run owns this session on the host.
  const controlRunId = currentIntent?.runId ?? foreignRun?.runId
  const projectAvailable = catalog?.projects.some((project) => project.path === cwd) ?? false
  const sessionArchived = Boolean(catalogSession?.archivedAt ?? catalog?.sessions.find(item => item.externalSessionId === sessionId && item.cwd === cwd &&
    item.providerId === providerId && (item.agentProfileId ?? '') === (provider?.agentProfileId ?? ''))?.archivedAt)
  const contextAvailable = connected && catalogReady && pollFresh && Boolean(provider?.available) && remoteControlsValid(controlProvider, controls) && projectAvailable && !sessionArchived
  useEffect(() => {
    if (sessionArchived) queueStore.clearSession(draftKey)
  }, [sessionArchived, queueStore, draftKey])

  // An unknown submission receipt blocks sending before any freshness state (main 0c124aa);
  // otherwise stale or refreshing host evidence blocks it (batch A3).
  const sendBlockedReason = unknownReceiptBlocked
    ? copy.unknownReceiptSendBlocked
    : catalogEntry?.error || pollError
    ? catalogEntry?.error ?? pollError
    : connectionRefreshing || (connected && (!catalogReady || !pollFresh))
      ? copy.loadingDesktopStatus
    : !connection
    ? '这台主机已不在保存列表中；草稿已保留，不会改用本机执行'
    : !connected
      ? `${host} 未连接；草稿已保留，连接后再发送`
      : !catalog
        ? `正在读取 ${host} 的项目与 Provider`
        : !projectAvailable
          ? `${host} 上已没有这个项目；不会代选其他目录`
          : sessionArchived
            ? '该会话已归档；请恢复会话或新建会话'
          : !provider
            ? '原 Provider / profile 在主机上已不可用；不会代选其他运行环境'
            : !provider.available
              ? `${provider.label} 在 ${host} 上不可用`
              : providerControlsError || (controlProvider && !controlProvider.available)
                ? copy.providerControlsUnavailable(host)
                : !controlProvider
                  ? copy.loadingProviderControls
                  : !remoteControlsValid(controlProvider, controls)
                    ? copy.providerControlsChanged
                    : null

  const submission = (text: string, attachments: AgentInputAttachment[] = []) => ({
    context, prompt: text,
    ...(attachments.length ? { attachments } : {}),
    ...(chosenModel ? { modelId: chosenModel.id, modelProviderId: chosenModel.providerId } : {}),
    ...(validEffort ? { effort: validEffort } : {}),
    ...(validPermissionMode ? { permissionMode: validPermissionMode } : {})
  })
  const execute = async (request: ReturnType<typeof submission>, queued: boolean, submittedAttachments: ComposerDraftAttachment[] = []): Promise<void> => {
    if (submissionInFlight.current) return
    submissionInFlight.current = true
    const submittedGeneration = contextGeneration.current
    const submittedKey = draftKey
    setSubmitting(true); setError(null); setStatus(null); setPollInterval(POLL_MS)
    let acknowledged = false
    try {
      const intent = await api.submit(connectionId, request)
      acknowledged = true
      if (queued) queueStore.submitted(queueKey, intent)
      // Preserve edits made while the network write was pending.
      else {
        const current = draftStore.getSnapshot().get(submittedKey)
        if (current) {
          const unchangedText = current.input.trim() === request.prompt
          const remaining = attachmentsAfterSuccessfulSubmit(current.attachments, new Set(submittedAttachments.map(attachment => attachment.id)))
          if (unchangedText || remaining.length !== current.attachments.length) {
            updateDraft(submittedKey, (draft) => ({ input: unchangedText ? '' : draft.input, attachments: remaining }))
          }
        }
        releaseAttachments(submittedAttachments.filter(attachment => !draftStore.getSnapshot().get(submittedKey)?.attachments.some(current => current.id === attachment.id)))
      }
      if (submittedGeneration !== contextGeneration.current) return
      setIntents((current) => [...current.filter((item) => item.intentId !== intent.intentId), intent])
      if (shouldQueryUnknownIntent(intent)) {
        const queried = await api.intentStatus(connectionId, intent.intentId)
        if (submittedGeneration !== contextGeneration.current) return
        setIntents((current) => current.map((item) => item.intentId === queried.intentId ? queried : item))
      }
    } catch (reason) {
      if (queued && !acknowledged) queueStore.fail(queueKey)
      if (submittedGeneration === contextGeneration.current) {
        const detail = errorText(reason)
        setError(detail.includes('desktop_remote_attachments_unsupported') ? REMOTE_ATTACHMENTS_COPY.unsupported : detail)
        setStatus(null)
      }
    } finally { submissionInFlight.current = false; setSubmitting(false) }
  }
  const attachmentBytes = (attachment: AgentInputAttachment): number => attachment.size ?? Math.floor(attachment.dataBase64.length * 3 / 4)
  const attachmentError = (attachments: readonly AgentInputAttachment[]): string | null => {
    const capability = catalog?.attachments
    const maxBytes = capability?.maxBytes ?? 512 * 1024
    const maxTotalBytes = capability?.maxTotalBytes ?? 700 * 1024
    if (attachments.length > (capability?.maxCount ?? 16)) return REMOTE_ATTACHMENTS_COPY.tooMany
    if (attachments.some(attachment => attachmentBytes(attachment) > maxBytes) || attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0) > maxTotalBytes) return REMOTE_ATTACHMENTS_COPY.tooLarge
    return null
  }
  const submit = async (): Promise<void> => {
    const draft = draftStore.getSnapshot().get(draftKey)
    const text = (draft?.input ?? '').trim()
    const submittedAttachments = draft?.attachments ?? []
    const attachments = inputAttachments(submittedAttachments)
    if (!contextAvailable || unknownReceiptBlocked || (!text && attachments.length === 0) || submitting) return
    const limitError = attachmentError(attachments)
    if (limitError) { setError(limitError); return }
    const request = submission(text, attachments)
    if (runActive || queue.prompts.length > 0) {
      try {
        if (editingMessageId) {
          const edited = editingMessageId
          const moved = queueStore.enqueueEdited(queueKey, connectionId, edited, request, currentIntent?.intentId)
          // 队列在点击与提交之间变了（例如刚被提交）时不能丢文本：退回普通入队。
          if (moved) {
            setMovedMessageId(moved.messageId)
          } else {
            setError(QUEUE_COPY.editMissing)
            queueStore.enqueue(queueKey, connectionId, request, currentIntent?.intentId)
          }
          setEditingMessageId(null)
        } else {
          queueStore.enqueue(queueKey, connectionId, request, currentIntent?.intentId)
        }
        updateDraft(draftKey, () => ({ input: '', attachments: [] }))
        releaseAttachments(submittedAttachments)
      } catch (reason) { setError(errorText(reason)) }
      return
    }
    await execute(request, false, submittedAttachments)
  }
  useEffect(() => {
    if (!contextAvailable || unknownReceiptBlocked || runActive || submitting || pollError || submissionInFlight.current) return
    // 跳过正在编辑的那条：否则远端一空下来就会发出去改了一半的旧文本。
    const next = queueStore.claim(queueKey, editingMessageId ?? undefined)
    if (next) void execute(next.submission, true)
  }, [queue, contextAvailable, unknownReceiptBlocked, runActive, submitting, pollError, queueKey, editingMessageId])

  // 队列条目离开队列（移除、被提交、归档）后编辑态必须跟着结束。
  useEffect(() => {
    if (!editingMessageId) return
    if (queue.prompts.some(prompt => prompt.messageId === editingMessageId)) return
    setEditingMessageId(null)
  }, [editingMessageId, queue.prompts])

  useEffect(() => {
    if (!movedMessageId) return
    const timer = window.setTimeout(() => setMovedMessageId(null), 2500)
    return () => window.clearTimeout(timer)
  }, [movedMessageId])
  const resolveUnknown = async (intent: DesktopRemoteIntent): Promise<void> => {
    if (resolvingIntentId) return
    setResolvingIntentId(intent.intentId)
    queueStore.pauseConnection(connectionId)
    setUnknownReceiptError(null)
    setError(null)
    try {
      // This is the only explicit recovery action. It uses the original receipt
      // id and never submits a replacement prompt or stops a received run.
      const resolved = await api.resolveIntent(connectionId, intent.intentId)
      setIntents((current) => current.map((item) => item.intentId === resolved.intentId ? resolved : item))
      setStatus(null)
    } catch (reason) {
      const detail = errorText(reason)
      setUnknownReceiptError(detail.includes('desktop_remote_unknown_op')
        ? copy.unknownReceiptUpgrade(host)
        : copy.unknownReceiptFailure(detail))
    } finally { setResolvingIntentId(null) }
  }
  const stop = async (): Promise<void> => {
    const runId = controlRunId
    if (!runId) { setError('当前没有可停止的远端运行。'); return }
    setPollInterval(POLL_MS)
    try { await api.stop(connectionId, runId); setStatus('已请求停止，等待远端确认。') } catch (reason) { setError(errorText(reason)) }
  }
  const answer = async (response: AgentQuestionResponse): Promise<void> => {
    const runId = controlRunId
    if (!connected || !runId) { const reason = new Error('远端未连接或问题所属运行已不可用。'); setError(reason.message); throw reason }
    setPollInterval(POLL_MS)
    try { await api.answer(connectionId, runId, response); setStatus('已发送回答。') } catch (reason) { setError(errorText(reason)); throw reason }
  }
  const loadOlderHistory = async (): Promise<void> => {
    if (!connected || !historyEvidence?.hasOlder || historyEvidence.before === undefined || !sessionId) return
    const sequence = ++generation.current
    try {
      const history = await api.history(connectionId, context, historyEvidence.before, historyEvidence.snapshot)
      if (sequence !== generation.current) return
      setTurns((current) => [...historyTurns(history), ...current])
      setHistoryError(null)
      setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
    } catch (reason) { if (sequence === generation.current) setHistoryError(errorText(reason)) }
  }
  const connect = useCallback(async (): Promise<void> => {
    setConnecting(true); setError(null)
    try {
      await api.connect(connectionId)
      await refreshDesktopConnections()
      await refreshRemoteCatalog(connectionId)
    } catch (reason) { setError(errorText(reason)) } finally { setConnecting(false) }
  }, [api, connectionId])

  // Map host Providers to the shared picker. Unavailable entries stay visible and
  // disabled; a session whose Provider vanished keeps a placeholder, never a substitute.
  const missingAgentId = providerSelection && catalog && !provider
    ? remoteAgentId({ id: (JSON.parse(providerSelection) as [string, string])[0], agentProfileId: (JSON.parse(providerSelection) as [string, string])[1] || undefined })
    : null
  const agents = useMemo<DetectedAgent[]>(() => {
    const listed = (catalog?.providers ?? []).map((item) => ({ id: remoteAgentId(item), name: item.label, bin: item.id, path: `${host} · ${item.id}` }))
    if (missingAgentId) listed.push({ id: missingAgentId, name: '原 Provider / profile 已不可用', bin: '', path: host })
    return listed
  }, [catalog, host, missingAgentId])
  const unavailableAgentIds = useMemo(() => new Set([
    ...(catalog?.providers ?? []).filter((item) => !item.available).map(remoteAgentId),
    ...(missingAgentId ? [missingAgentId] : [])
  ]), [catalog, missingAgentId])
  const selectedAgentId = provider ? remoteAgentId(provider) : missingAgentId ?? ''

  const unknownIntent = intents.find((intent) => intent.status === 'unknown')
  const noticeError = error ?? pollError ?? historyError ?? catalogEntry?.error
  const notice = connectionRefreshing || (connected && !noticeError && (!catalogReady || !pollFresh))
    ? { tone: 'blocked' as const, text: copy.loadingDesktopStatus }
    : !connected
    ? {
        tone: 'blocked' as const,
        text: !connection
          ? '这台主机已不在保存列表中。草稿会保留，不会改用本机执行。'
          : readError
            ? `无法确认 ${host} 的连接状态。草稿会保留，不会改用本机执行。`
            : connection.state === 'pairing'
              ? `${host} 尚未批准此设备。请在“主机”页完成配对。`
              : `${host} 未连接。草稿会保留，连接后不会自动发送。`,
        ...(connection && connection.state === 'disconnected' && !readError
          ? { action: { label: connecting ? '正在连接…' : '连接', onClick: () => void connect(), disabled: connecting } }
          : {})
      }
    : unknownIntent
      ? { tone: 'blocked' as const,
          text: copy.unknownReceiptNotice(unknownIntent.context.cwd, unknownReceiptError ?? unknownIntent.failure),
          action: { label: resolvingIntentId === unknownIntent.intentId ? copy.unknownReceiptResolving : copy.unknownReceiptResolve,
            onClick: () => void resolveUnknown(unknownIntent), disabled: resolvingIntentId !== null } }
    : noticeError
      ? { tone: 'error' as const, text: noticeError }
      : queue.paused && queue.prompts.length > 0
        ? { tone: 'blocked' as const,
            text: queue.writeUnknown ? '上一条提交结果未知；不会自动重发。请核对远端记录后移除该条消息。' : '远程队列已暂停；重连不会自动发送。',
            ...(!queue.writeUnknown ? { action: { label: '继续队列', onClick: () => queueStore.resume(queueKey) } } : {}) }
      : currentRunStatus?.state === 'unknown'
        ? { tone: 'blocked' as const, text: `远程运行结果未知${currentRunStatus.detail ? ` · ${currentRunStatus.detail}` : ''}；不会自动重试。` }
        // Stop/answer notes remain relevant while the run is in flight.
        : status && (submitting || runActive)
          ? { tone: 'blocked' as const, text: status }
          // Receipt acknowledgement is not dispatch. Only this run's host state
          // can retire the waiting notice, even before its first trace arrives.
          : currentIntent?.status === 'recorded' && (!currentRunStatus || currentRunStatus.state === 'recorded')
            ? { tone: 'blocked' as const, text: '已记录提交，等待远端派发…' }
            : submitting && !currentIntent
              ? { tone: 'blocked' as const, text: '正在提交到远端…' }
              : null

  const diffReview = sessionNetDiffReview(displayTurns) ?? resolveTurnDiffReview(displayTurns)
  // Keep an open editor mounted while offline, so a disconnect cannot discard edits.
  const workspaceAvailable = projectAvailable
  const upgradeWorkbench = <div className="surface-unavailable"><b>需要更新远端 Scry</b><span>请更新 {host}，以启用文件编辑、源代码管理和终端。</span></div>

  return (
    <>
      <ChatView
        turns={displayTurns}
        selectedId={selected?.id ?? null}
        scrollRef={scrollRef}
        textareaRef={textareaRef}
        cwd={cwd}
        workspaceRoots={[cwd]}
        recent={[]}
        agents={agents}
        selectedAgentId={selectedAgentId}
        agentLocked={Boolean(sessionId) || runActive || submitting}
        hasSelectedSession={Boolean(sessionId)}
        runControls={controls}
        runControlCatalog={runControlCatalog}
        runControlsReason={provider && runControlCatalog.models.length === 0 ? `${host} 未提供模型列表；使用 Provider 默认模型` : null}
        input={input}
        composerScopeKey={draftKey}
        sendBlockedReason={sendBlockedReason}
        submitting={submitting}
        sessionLoading={historyLoading && displayTurns.length === 0}
        sessionEvidenceGap={sessionId && historyEvidence?.status === 'unavailable' && displayTurns.length === 0
          ? { status: 'unavailable', detail: historyEvidence.reason ?? `${host} 未提供这条会话的归档` }
          : null}
        busy={pollFresh && runActive && Boolean(controlRunId)}
        draftAttachments={draftAttachments}
        queuedPrompts={queue.prompts}
        editingQueuedId={editingMessageId}
        movedQueuedId={movedMessageId}
        onEditQueuedPrompt={(messageId) => {
          const prompt = queue.prompts.find(candidate => candidate.messageId === messageId)
          if (!prompt) return
          if (queue.claimed === messageId) { setError(QUEUE_COPY.editClaimed); return }
          setError(null)
          setEditingMessageId(messageId)
          setMovedMessageId(null)
          updateDraft(draftKey, () => ({ input: prompt.text, attachments: [] }))
          window.setTimeout(() => textareaRef.current?.focus(), 0)
        }}
        onCancelQueuedPromptEdit={() => {
          setEditingMessageId(null)
          updateDraft(draftKey, () => ({ input: '', attachments: [] }))
          window.setTimeout(() => textareaRef.current?.focus(), 0)
        }}
        queueWhileBusy
        slashOpen={slashOpen}
        slashLoading={slashLoading}
        slashCmds={slashCmds}
        slashReason={slashReason}
        slashSel={slashSel}
        pendingQuestions={activeRun?.pendingQuestions}
        historyWindow={historyEvidence?.hasOlder && historyEvidence.before !== undefined && sessionId
          ? { sessionId, offset: 0, totalTurns: displayTurns.length, hasOlder: true, completeness: 'partial' }
          : null}
        onLoadOlderTurns={connected ? () => { void loadOlderHistory() } : undefined}
        onSelect={setSelected}
        onForkTurn={catalog?.sessionFork && provider?.forkSession && connected && !sessionArchived ? async (turn) => {
          const id = providerIdForAgentId(provider.id)
          const boundary = turn.forkTurnId ?? turn.providerTurnId
          if (!sessionId || !turn.providerTurnId || !boundary) throw new Error(REMOTE_SESSION_COPY.forkBoundaryMissing)
          if (!id) throw new Error(REMOTE_SESSION_COPY.forkUnsupported)
          const sourceGeneration = generation.current
          const forked = await api.forkSession(connectionId, {
            providerId: id, agentProfileId: provider.agentProfileId, cwd, sourceSessionId: sessionId,
            sourceRunId: turn.runId, sourceProviderTurnId: turn.providerTurnId, sourceForkTurnId: boundary,
            model: controls.model, permissionMode: validPermissionMode as AgentPermissionMode | undefined
          }).catch(reason => { throw new Error(errorText(reason)) })
          await refreshRemoteCatalog(connectionId)
          if (generation.current !== sourceGeneration) return
          setSessionId(forked.externalSessionId)
          onSessionAdopted(forked.externalSessionId, provider)
        } : undefined}
        onOpenDiff={() => dispatchSurface({ type: 'open', kind: 'diff' })}
        onOpenFile={(target) => {
          setFileRequest({ ...target, id: Date.now() })
          dispatchSurface({ type: 'open', kind: 'files' })
        }}
        onAnswerQuestion={answer}
        onInput={(value) => onDraftInput(draftKey, value)}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => setSlashRevision(revision => revision + 1)}
        onPickSlash={(cmd) => {
          onDraftInput(draftKey, `/${cmd.name.replace(/^\/+/, '')} `)
          setSlashHidden(true)
          textareaRef.current?.focus()
        }}
        onSlashSel={setSlashSel}
        onHideSlash={() => setSlashHidden(true)}
        onSend={() => { void submit() }}
        onStop={() => { void stop() }}
        onPasteImages={(files) => {
          void Promise.all(files.map((file, index) => fileToDraftAttachment(file, index))).then((next) => {
            const attachments = next.filter((attachment): attachment is ComposerDraftAttachment => attachment != null)
            if (attachments.length) updateDraft(draftKey, (draft) => ({ ...draft, attachments: [...draft.attachments, ...attachments] }))
          }).catch((reason) => setError(errorText(reason)))
        }}
        onPasteClipboardImage={() => {
          void window.scry.clipboardImage().then((attachment) => {
            if (attachment) updateDraft(draftKey, (draft) => ({ ...draft, attachments: [...draft.attachments, clipboardAttachmentToDraft(attachment)] }))
          }).catch((reason) => setError(errorText(reason)))
        }}
        onRemoveDraftAttachment={(id) => {
          const removed = draftAttachments.filter(attachment => attachment.id === id)
          updateDraft(draftKey, (draft) => ({ ...draft, attachments: draft.attachments.filter(attachment => attachment.id !== id) }))
          releaseAttachments(removed)
        }}
        onRemoveQueuedPrompt={(messageId) => {
          if (queue.writeUnknown && queue.claimed === messageId) setError(null)
          queueStore.remove(queueKey, messageId)
        }}
        onSelectAgent={(agentId) => {
          const next = catalog?.providers.find((item) => remoteAgentId(item) === agentId)
          if (next?.available) setProviderSelection(desktopProviderKey(next))
        }}
        unavailableAgentIds={unavailableAgentIds}
        agentScopeLabel={`${host} 上的 Agent`}
        onRunModel={(model: AgentModelRef | undefined) => {
          const option = controlProvider?.models?.find((item) => item.id === model?.id && (item.providerId ?? '') === (model?.providerId ?? ''))
          setControls((current) => ({ ...current, model, effort: defaultOption(option?.efforts ?? controlProvider?.efforts) }))
        }}
        onRunEffort={(effort) => setControls((current) => ({ ...current, effort }))}
        onPermissionMode={(permissionMode) => setControls((current) => ({ ...current, permissionMode }))}
        renderLocationPicker={renderLocationPicker}
        remoteHost={host}
        composerNotice={notice ?? (providerControlsError || (controlProvider && !controlProvider.available)
          ? { tone: 'blocked', text: copy.providerControlsUnavailable(host), action: { label: copy.retryProviderControls, onClick: () => setProviderControlsRevision(value => value + 1) } }
          : !controlProvider && provider && connected
            ? { tone: 'blocked', text: copy.loadingProviderControls }
            : controlProvider && !remoteControlsValid(controlProvider, controls)
              ? { tone: 'blocked', text: copy.providerControlsChanged }
              : catalog?.providerDiscovery !== 2 && controlProvider
                ? { tone: 'blocked', text: copy.legacyProviderControls }
                : controlProvider && !runActive
                  ? { tone: 'info', text: controlsObserved, action: { label: copy.refreshProviderControls, disabled: providerControlsLoading, onClick: () => setProviderControlsRevision(value => value + 1) } }
                  : null)}
      />
      {surface.target && createPortal(
        <RightSurfacePanel
          openIds={surface.state.openIds}
          activeId={surface.state.activeId}
          maximized={surface.state.maximized}
          retainTerminal={surface.retainTerminal}
          onOpen={(kind) => dispatchSurface({ type: 'open', kind })}
          onActivate={(kind) => dispatchSurface({ type: 'activate', kind })}
          onClose={(kind) => dispatchSurface({ type: 'close', kind })}
          onHide={() => surface.onAction({ type: 'hide' })}
          onToggleMaximized={() => surface.onAction({ type: 'toggle-maximized' })}
          contents={{
            overview: sessionId && historyEvidence?.status === 'unavailable' && displayTurns.length === 0
              ? <div className="surface-unavailable"><b>会话证据不可用</b><span>{historyEvidence.reason ?? `${host} 未提供这条会话的归档`}</span></div>
              : <OverviewPanel
                  turns={displayTurns} sessionId={sessionId} selected={selected}
                  runtimeProvider={runtimeProviderForAgentId(providerId)} usage={null} stats={null}
                  busy={pollFresh && runActive} onSelect={setSelected}
                />,
            files: workspaceAvailable
              ? catalog?.workbench === 1
                ? <WorkspacePanel cwd={cwd} api={workbench.workspace} openRequest={fileRequest}
                    onClose={() => dispatchSurface({ type: 'close', kind: 'files' })}
                    onDirtyChange={(dirty) => { setWorkspaceDirty(dirty); surface.onDirtyChange?.(dirty) }}
                    onAddReference={(entry) => onDraftInput(draftKey, `${input}${input && !input.endsWith(' ') ? ' ' : ''}${workspaceReferenceToken(entry)} `)} />
                : <RemoteFiles api={api} connectionId={connectionId} context={context} onClose={() => dispatchSurface({ type: 'close', kind: 'files' })} />
              : <div className="surface-unavailable"><b>文件不可用</b><span>{sendBlockedReason ?? '当前上下文不可读取文件。'}</span></div>,
            'source-control': catalog?.workbench === 1 ? <SourceControlPanel cwd={cwd} api={workbench.sourceControl} active={surface.state.visible && surface.state.activeId === 'source-control'} /> : upgradeWorkbench,
            terminal: catalog?.workbench === 1 ? <Suspense fallback={<div className="surface-unavailable">正在加载终端…</div>}><TerminalSurface cwd={cwd} scopeId={surface.scopeId} api={workbench.terminal} machineLabel={host} active={surface.state.visible && surface.state.activeId === 'terminal'} /></Suspense> : upgradeWorkbench,
            agents: <AgentsSurface turns={displayTurns} busy={pollFresh && runActive} />,
            diff: diffReview ? <TurnDiffReviewPanel review={diffReview} onClose={() => dispatchSurface({ type: 'close', kind: 'diff' })} />
              : <div className="surface-unavailable"><b>本会话还没有可审阅的改动</b><span>某一轮产生 Git 净改动后，这里会显示真实会话改动。</span></div>
          }}
        />, surface.target
      )}
    </>
  )
}

function intentMatches(intent: DesktopRemoteIntent, context: DesktopRemoteContext): boolean {
  return intent.context.cwd === context.cwd && intent.context.providerId === context.providerId &&
    (intent.context.agentProfileId ?? '') === (context.agentProfileId ?? '') && (intent.context.externalSessionId ?? '') === (context.externalSessionId ?? '')
}
