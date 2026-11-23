import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentRunControls } from '@shared/runtime'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import { type WorkspaceOpenRequest } from './WorkspacePanel'
import { createRemoteWorkbench } from '../remote-workbench'
import type { RightSurfaceAction } from '../right-surface'
import type { DesktopRemoteContext, DesktopRemoteHistory, DesktopRemoteIntent, DesktopRemoteRunStatus, DesktopRemoteLiveRun, RemoteProviderRef } from '@shared/desktop-remote'
import type { WorkspaceStartSelection } from '@shared/workspace-selection'
import type { Turn } from '../format'
import { updateComposerDraft, type ComposerDraft, type ComposerDraftAttachment } from '../composer-drafts'

export interface PendingRemoteWorktreeSubmit {
  draftKey: string
  prompt: string
  attachments: ComposerDraftAttachment[]
  workspace: WorkspaceStartSelection
  intentId?: string
  runId?: string
  cancelling?: boolean
  cancelRequested?: boolean
}

import { remoteQueueKey } from '../remote-prompt-queue'
import type { SlashCmd } from '@shared/trace'
import { useDesktopConnections } from '../hooks/useDesktopConnections'
import { useRemoteCatalogs } from '../hooks/useRemoteCatalogs'
import { type RemoteTraceView } from '../remote-trace'
import { bridge, desktopProviderKey, historyTurns } from './DesktopRemote'
import { readRemoteProviderKey } from '../remote-run-controls'
import type { RemoteChatProps } from './RemoteChat'
import { errorText, remoteDraftKey } from './RemoteChatShared'



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
  const [historyLoading, setHistoryLoading] = useState(preparedHistory?.status === 'loading')
  const [historyRevision, setHistoryRevision] = useState(0)
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)
  const traceViewRef = useRef<RemoteTraceView | null>(null)
  const showTrace = useCallback((view: RemoteTraceView | null): void => {
    traceViewRef.current = view
    setActiveRun(view?.run ?? null)
  }, [])
  const [runStatus, setRunStatus] = useState<(DesktopRemoteRunStatus & { runId: string }) | null>(null)
  const [foreignRun, setForeignRun] = useState<DesktopRemoteLiveRun | null>(null)
  const foreignRunRef = useRef(foreignRun)
  foreignRunRef.current = foreignRun
  const [intents, setIntents] = useState<DesktopRemoteIntent[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [pollFresh, setPollFresh] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(preparedHistory?.status === 'error' ? preparedHistory.error : null)
  const [historyOlderLoading, setHistoryOlderLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pendingWorktree, setPendingWorktreeState] = useState<PendingRemoteWorktreeSubmit | null>(null)
  const pendingWorktreeRef = useRef<PendingRemoteWorktreeSubmit | null>(null)
  const setPendingWorktree = useCallback((next: PendingRemoteWorktreeSubmit | null | ((current: PendingRemoteWorktreeSubmit | null) => PendingRemoteWorktreeSubmit | null)): void => {
    setPendingWorktreeState((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      pendingWorktreeRef.current = resolved
      return resolved
    })
  }, [])
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
  const appliedPreparedHistory = useRef(preparedHistory)
  const preparedHistoryRequest = useRef(generation.current)
  useEffect(() => {
    if (!preparedHistory || appliedPreparedHistory.current === preparedHistory) return
    appliedPreparedHistory.current = preparedHistory
    preparedHistoryContext.current = preparedHistory.status === 'loading' ? contextKey : undefined
    if (preparedHistory.status === 'loading') {
      preparedHistoryRequest.current = generation.current
      setHistoryLoading(true)
      return
    }
    if (preparedHistoryRequest.current !== generation.current) return
    setHistoryLoading(false)
    if (preparedHistory.status === 'error') {
      setHistoryError(preparedHistory.error)
      return
    }
    setHistoryError(null)
    setTurns(historyTurns(preparedHistory.history))
    setHistoryEvidence({
      status: preparedHistory.history.status, reason: preparedHistory.history.reason,
      hasOlder: preparedHistory.history.hasOlder, before: preparedHistory.history.before,
      snapshot: preparedHistory.history.snapshot
    })
    presentedHistoryContext.current = context
  }, [context, contextKey, preparedHistory])
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
  const updateDraft = useCallback((key: string, update: (current: ComposerDraft) => Pick<ComposerDraft, 'input' | 'attachments'>): void => {
    draftStore.update((drafts) => {
      const result = updateComposerDraft(drafts, key, current => ({ ...current, ...update(current) }))
      for (const evicted of result.evicted) releaseAttachments(evicted.attachments)
      return result.drafts
    })
  }, [draftStore, releaseAttachments])
  const queueKey = remoteQueueKey(draftKey, providerSelection)
  const readQueue = () => queueStore.get(queueKey)
  const queue = useSyncExternalStore(queueStore.subscribe, readQueue, readQueue)
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

  useEffect(() => {
    if (providerSelection || !catalog) return
    const saved = readRemoteProviderKey(connectionId)
    const first = catalog.providers.find(item => item.available && desktopProviderKey(item) === saved) ??
      catalog.providers.find((item) => item.available) ?? catalog.providers[0]
    if (first) setProviderSelection(desktopProviderKey(first))
  }, [catalog, connectionId, providerSelection])

  useEffect(() => {
    if (previousContextKey.current === contextKey) return
    previousContextKey.current = contextKey
    openingLatest.current = true
    followLatest.current = true
    contextGeneration.current += 1
    const preserveAdoptedRun = adoptingSession.current
    adoptingSession.current = false
    if (!preserveAdoptedRun) {
      adoptedIntent.current = undefined
      showTrace(null)
      setRunStatus(null)
      if (pendingWorktreeRef.current) {
        releaseAttachments(pendingWorktreeRef.current.attachments)
        setPendingWorktree(null)
      }
    }
    setForeignRun(null)
    setStatus(null); setError(null); setPollError(null); setHistoryError(null); setHistoryEvidence(null); setTurns([])
  }, [contextKey, showTrace])
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


  return { api, workbench, fileRequest, setFileRequest, workspaceDirty, setWorkspaceDirty, dispatchSurface, connections, connectionRefreshing, readError, connection, connected, host, catalogEntry, catalog, catalogReady, providerSelection, setProviderSelection, sessionId, setSessionId, controls, setControls, selectedProvider, setSelectedProvider, selectedProviderContextKey, setSelectedProviderContextKey, providerControlsError, setProviderControlsError, providerControlsLoading, setProviderControlsLoading, providerControlsRevision, setProviderControlsRevision, controlsVisible, setControlsVisible, initializedControlsContext, turns, setTurns, selected, setSelected, historyEvidence, setHistoryEvidence, historyLoading, setHistoryLoading, historyRevision, setHistoryRevision, activeRun, setActiveRun, traceViewRef, showTrace, runStatus, setRunStatus, foreignRun, setForeignRun, foreignRunRef, intents, setIntents, status, setStatus, error, setError, pollError, setPollError, pollFresh, setPollFresh, historyError, setHistoryError, historyOlderLoading, setHistoryOlderLoading, submitting, setSubmitting, pendingWorktree, pendingWorktreeRef, setPendingWorktree, connecting, setConnecting, resolvingIntentId, setResolvingIntentId, unknownReceiptError, setUnknownReceiptError, generation, openingLatest, followLatest, provider, providerId, context, presentedHistoryContext, preparedHistoryContext, controlContextKey, contextKey, catalogSession, sessionActive, traceDelta, previousContextKey, contextGeneration, pollSequence, pollInFlight, pollRef, adoptingSession, adoptedIntent, draftKey, input, draftAttachments, releaseAttachments, updateDraft, queueKey, queue, editingMessageId, setEditingMessageId, movedMessageId, setMovedMessageId, slashCmds, setSlashCmds, slashReason, setSlashReason, slashLoading, setSlashLoading, slashRevision, setSlashRevision, slashSel, setSlashSel, slashHidden, setSlashHidden, submissionInFlight, slashOpen }
}

export type FoundationState = ReturnType<typeof useRemoteChatFoundation>
