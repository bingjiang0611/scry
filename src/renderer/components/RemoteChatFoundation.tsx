import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentRunControls } from '@shared/runtime'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import { type WorkspaceOpenRequest } from './WorkspacePanel'
import { createRemoteWorkbench } from '../remote-workbench'
import type { RightSurfaceAction } from '../right-surface'
import type { DesktopRemoteContext, DesktopRemoteHistory, DesktopRemoteIntent, DesktopRemoteRunStatus, DesktopRemoteLiveRun, RemoteProviderRef } from '@shared/desktop-remote'
import type { Turn } from '../format'
import { updateComposerDraft, type ComposerDraftAttachment } from '../composer-drafts'

import { remoteQueueKey } from '../remote-prompt-queue'
import type { SlashCmd } from '@shared/trace'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { type RemoteTraceView } from '../remote-trace'
import { bridge, desktopProviderKey, historyTurns } from './DesktopRemote'
import { readRemoteProviderKey } from '../remote-run-controls'
import type { RemoteChatProps } from './RemoteChat'
import { errorText, POLL_MS, remoteDraftKey } from './RemoteChatShared'

// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.


const EMPTY_DRAFT_ATTACHMENTS: ComposerDraftAttachment[] = []

export function useRemoteChatFoundation({ connectionId, cwd, session, preparedHistory, draftStore, queueStore, surface }: Pick<RemoteChatProps, 'connectionId' | 'cwd' | 'session' | 'preparedHistory' | 'draftStore' | 'queueStore' | 'surface'>) {
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
    const saved = readRemoteProviderKey(connectionId)
    const first = catalog?.providers.find(item => item.available && desktopProviderKey(item) === saved) ??
      catalog?.providers.find((item) => item.available) ?? catalog?.providers[0]
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
  const [turns, setTurns] = useState<Turn[]>(() => preparedHistory?.status === 'ready' ? historyTurns(preparedHistory.history) : [])
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [historyEvidence, setHistoryEvidence] = useState<Pick<DesktopRemoteHistory, 'status' | 'reason' | 'hasOlder' | 'before' | 'snapshot'> | null>(preparedHistory?.status === 'ready' ? preparedHistory.history : null)
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
  const [historyError, setHistoryError] = useState<string | null>(preparedHistory?.status === 'error' ? preparedHistory.error : null)
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
  const presentedHistoryContext = useRef<DesktopRemoteContext | null>(null)
  const controlContextKey = JSON.stringify([cwd, providerSelection])
  const contextKey = JSON.stringify([providerSelection, sessionId ?? ''])
  const catalogSession = sessionId ? catalog?.sessions.find(item => item.externalSessionId === sessionId && item.cwd === cwd &&
    item.providerId === providerId && (item.agentProfileId ?? '') === (provider?.agentProfileId ?? '')) : undefined
  const sessionActive = catalogSession?.isActive === true
  const traceDelta = catalog?.traceDelta === 1
  const previousContextKey = useRef<string | undefined>(preparedHistory ? contextKey : undefined)
  const preparedHistoryContext = useRef<string | undefined>(preparedHistory ? contextKey : undefined)
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

  // A new draft restores this host's Provider/profile once its catalog arrives.
  // An existing session keeps its recorded Provider even when the host removed it.
  useEffect(() => {
    if (providerSelection || !catalog) return
    const saved = readRemoteProviderKey(connectionId)
    const first = catalog.providers.find(item => item.available && desktopProviderKey(item) === saved) ??
      catalog.providers.find((item) => item.available) ?? catalog.providers[0]
    if (first) setProviderSelection(desktopProviderKey(first))
  }, [catalog, connectionId, providerSelection])

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
    // Failure must discard the observation, never reuse it as current.
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


  return { api, workbench, fileRequest, setFileRequest, workspaceDirty, setWorkspaceDirty, dispatchSurface, connections, connectionRefreshing, readError, connection, connected, host, catalogEntry, catalog, catalogReady, providerSelection, setProviderSelection, sessionId, setSessionId, controls, setControls, selectedProvider, setSelectedProvider, selectedProviderContextKey, setSelectedProviderContextKey, providerControlsError, setProviderControlsError, providerControlsLoading, setProviderControlsLoading, providerControlsRevision, setProviderControlsRevision, controlsVisible, setControlsVisible, initializedControlsContext, turns, setTurns, selected, setSelected, historyEvidence, setHistoryEvidence, historyLoading, setHistoryLoading, historyRevision, setHistoryRevision, activeRun, setActiveRun, traceViewRef, showTrace, pollIntervalMs, applyPollInterval, setPollInterval, lastPollKey, runStatus, setRunStatus, foreignRun, setForeignRun, foreignRunRef, intents, setIntents, status, setStatus, error, setError, pollError, setPollError, pollFresh, setPollFresh, historyError, setHistoryError, submitting, setSubmitting, connecting, setConnecting, resolvingIntentId, setResolvingIntentId, unknownReceiptError, setUnknownReceiptError, generation, openingLatest, followLatest, provider, providerId, context, presentedHistoryContext, preparedHistoryContext, controlContextKey, contextKey, catalogSession, sessionActive, traceDelta, previousContextKey, contextGeneration, pollSequence, pollInFlight, pollRef, adoptingSession, adoptedIntent, draftKey, input, draftAttachments, releaseAttachments, updateDraft, queueKey, queue, editingMessageId, setEditingMessageId, movedMessageId, setMovedMessageId, slashCmds, setSlashCmds, slashReason, setSlashReason, slashLoading, setSlashLoading, slashRevision, setSlashRevision, slashSel, setSlashSel, slashHidden, setSlashHidden, submissionInFlight, slashOpen }
}

export type FoundationState = ReturnType<typeof useRemoteChatFoundation>
