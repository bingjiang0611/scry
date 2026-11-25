import { useEffect } from 'react'
import type { AgentRunControls } from '@shared/runtime'
import { runStructuralTransition } from '../structural-motion'
import type { DesktopRemoteContext, DesktopRemoteRunStatus } from '@shared/desktop-remote'
import { remoteQueueKey } from '../remote-prompt-queue'
import { refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import { mergeRemoteTrace } from '../remote-trace'
import { desktopProviderKey, historyTurns } from './DesktopRemote'
import { initialRemoteRunControls, readRemoteRunControls, remoteRunControlsKey, writeRemoteRunControls } from '../remote-run-controls'
import type { FoundationState } from './RemoteChatFoundation'
import type { RemoteChatProps } from './RemoteChat'
import { errorText, intentMatches, keepIfEqual, remoteDraftKey } from './RemoteChatShared'
import { updateSessionComposerDraft } from '../app-model'
import { attachmentsAfterFailedSubmit, inputAfterFailedSubmit } from '../app-model'



export type ControlsState = ReturnType<typeof useRemoteChatControls>

export function useRemoteChatControls(foundation: FoundationState, { connectionId, cwd, draftStore, queueStore, onSessionAdopted }: Pick<RemoteChatProps, 'connectionId' | 'cwd' | 'draftStore' | 'queueStore' | 'onSessionAdopted'>) {
  const { api, connected, catalog, catalogReady, providerSelection, sessionId, setSessionId, setControls, selectedProvider, selectedProviderContextKey, initializedControlsContext, setTurns, setHistoryEvidence, setHistoryLoading, historyRevision, setHistoryRevision, traceViewRef, showTrace, setRunStatus, setForeignRun, foreignRunRef, setIntents, setError, setPollError, setPollFresh, setHistoryError, generation, provider, providerId, context, presentedHistoryContext, preparedHistoryContext, controlContextKey, contextKey, sessionActive, traceDelta, pollSequence, pollInFlight, pollRef, adoptingSession, adoptedIntent, queueKey, pendingWorktreeRef, setPendingWorktree, releaseAttachments } = foundation
  const controlProvider = catalog?.providerDiscovery !== 2 ? provider
    : selectedProvider && selectedProviderContextKey === controlContextKey && desktopProviderKey(selectedProvider) === providerSelection ? selectedProvider : undefined
  useEffect(() => {
    if (!controlProvider?.available || initializedControlsContext.current === contextKey) return
    initializedControlsContext.current = contextKey
    setControls(initialRemoteRunControls(controlProvider, readRemoteRunControls(remoteRunControlsKey(connectionId, controlProvider))))
  }, [connectionId, controlProvider, contextKey])

  const updateControls = (next: AgentRunControls): void => {
    setControls(next)
    if (controlProvider) writeRemoteRunControls(remoteRunControlsKey(connectionId, controlProvider), next)
  }

  useEffect(() => {
    if (!connected || !catalogReady || !providerId || !sessionId) {
      if (!sessionId) { setTurns([]); setHistoryEvidence(null) }
      setHistoryLoading(false)
      return
    }
    if (preparedHistoryContext.current !== undefined) {
      const preparedContext = preparedHistoryContext.current
      preparedHistoryContext.current = undefined
      if (preparedContext === contextKey) return
    }
    const sequence = ++generation.current
    setHistoryLoading(true)
    void api.history(connectionId, context).then((history) => {
      if (sequence !== generation.current) return
      const parsed = historyTurns(history)
      const commit = (): void => {
        setTurns(parsed)
        setHistoryError(null)
        setHistoryLoading(false)
        setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
        presentedHistoryContext.current = context
      }
      if (presentedHistoryContext.current !== context && parsed.length > 0) runStructuralTransition('session', commit)
      else commit()
    }).catch((reason) => {
      if (sequence !== generation.current) return
      console.error('[scry] remote transcript read failed', reason)
      setHistoryError(errorText(reason))
    })
      .finally(() => { if (sequence === generation.current) setHistoryLoading(false) })
    return () => { generation.current += 1 }
  }, [api, catalogReady, connectionId, connected, context, contextKey, historyRevision, providerId, sessionId])

  useEffect(() => {
    if (!connected || !catalogReady) return
    let cancelled = false
    const followTrace = async (runId: string, sequence: number, traceContext: DesktopRemoteContext = context): Promise<boolean | undefined> => {
      const previous = traceViewRef.current?.run.runId === runId ? traceViewRef.current : null
      const knownCount = previous?.run.attachments?.length
      const stale = (): boolean => cancelled || sequence !== pollSequence.current
      if (!traceDelta) {
        const run = await api.trace(connectionId, traceContext, runId, knownCount)
        if (stale()) return undefined
        const merged = mergeRemoteTrace(previous, { kind: 'snapshot', run })
        if (merged.kind === 'applied') showTrace(merged.view)
        return true
      }
      let merged = mergeRemoteTrace(previous, await api.traceDelta(connectionId, traceContext, runId, previous?.cursor, knownCount))
      if (stale()) return undefined
      if (merged.kind === 'gap') merged = mergeRemoteTrace(previous, await api.traceDelta(connectionId, traceContext, runId, undefined, knownCount))
      if (stale()) return undefined
      if (merged.kind === 'gap') throw new Error('remote_trace_gap')
      if (merged.changed) showTrace(merged.view)
      else traceViewRef.current = merged.view
      return merged.changed
    }
    let tracedRevision: string | undefined
    let refreshedTerminalIntent: string | undefined
    const readHint = async (
      runId: string, outputSeq: number | undefined, state: string, sequence: number, changed = false
    ): Promise<boolean | undefined> => {
      const revision = JSON.stringify([runId, outputSeq, state])
      if (tracedRevision === revision && !changed) return false
      const result = await followTrace(runId, sequence, traceContextFor(runId))
      if (result !== undefined) tracedRevision = revision
      return result
    }
    let intentTrace: { runId: string; context: DesktopRemoteContext } | undefined
    const traceContextFor = (runId: string): DesktopRemoteContext => intentTrace?.runId === runId ? intentTrace.context : context
    let immediate = true
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
          if (pendingWorktreeRef.current?.runId) {
            releaseAttachments(pendingWorktreeRef.current.attachments)
            setPendingWorktree(null)
          }
          const followed = foreignRunRef.current
          const live = context.externalSessionId && (sessionActive || followed) ? await api.liveRun(connectionId, context) : null
          if (cancelled || sequence !== pollSequence.current) return
          setForeignRun(keepIfEqual(live))
          if ((followed && live?.runId !== followed.runId) || (immediate && sessionActive && !live)) {
            setHistoryRevision((revision) => revision + 1)
            void refreshRemoteCatalog(connectionId)
          }
          if (live?.scryRunId) await readHint(live.scryRunId, live.outputSeq, live.state, sequence)
          else { tracedRevision = undefined; showTrace(null) }
          if (cancelled || sequence !== pollSequence.current) return
          setPollError(null)
          immediate = false
          setPollFresh(true)
          return
        }
        setForeignRun(null)
        const nextStatus = await api.runStatus(connectionId, activeIntent.runId)
        const effectiveCwd = nextStatus.cwd ?? activeIntent.context.cwd
        const effectiveContext: DesktopRemoteContext = {
          ...context, cwd: effectiveCwd,
          ...(nextStatus.externalSessionId ? { externalSessionId: nextStatus.externalSessionId } : {})
        }
        const boundQueueKey = nextStatus.externalSessionId
          ? remoteQueueKey(remoteDraftKey(connectionId, effectiveCwd, nextStatus.externalSessionId), providerSelection) : queueKey
        if (nextStatus.externalSessionId && !context.externalSessionId) {
          queueStore.migrate(queueKey, boundQueueKey, nextStatus.externalSessionId)
        }
        if (nextStatus.state === 'settled' || nextStatus.state === 'failed') queueStore.settle(boundQueueKey, activeIntent.intentId)
        if (cancelled || sequence !== pollSequence.current) return
        setRunStatus(keepIfEqual<(DesktopRemoteRunStatus & { runId: string }) | null>({ ...nextStatus, runId: activeIntent.runId }))
        const pendingWorktree = pendingWorktreeRef.current
        if (pendingWorktree && (!pendingWorktree.runId || pendingWorktree.runId === activeIntent.runId)) {
          const wpStage = nextStatus.workspaceProgress?.stage
          if (nextStatus.state === 'failed' || wpStage === 'cancelled' || wpStage === 'failed') {
            if (!nextStatus.externalSessionId && !traceViewRef.current) {
              const restoredSelection = { ...pendingWorktree.workspace, operationId: crypto.randomUUID() }
              draftStore.update(current => updateSessionComposerDraft(current, pendingWorktree.draftKey, draft => ({
                ...draft,
                input: inputAfterFailedSubmit(draft.input, pendingWorktree.prompt),
                attachments: attachmentsAfterFailedSubmit(draft.attachments, pendingWorktree.attachments),
                workspace: draft.workspace ?? restoredSelection
              })))
              if (!pendingWorktree.cancelling && wpStage !== 'cancelled') {
                setError(nextStatus.workspaceProgress?.message ?? nextStatus.detail ?? '创建 worktree 失败')
              }
            } else {
              releaseAttachments(pendingWorktree.attachments)
            }
            setPendingWorktree(null)
          } else if (nextStatus.state === 'settled' || wpStage === 'completed' || Boolean(nextStatus.externalSessionId)) {
            releaseAttachments(pendingWorktree.attachments)
            setPendingWorktree(null)
          }
        }
        if (nextStatus.externalSessionId && !context.externalSessionId && !activeIntent.context.externalSessionId) {
          adoptedIntent.current = activeIntent
          adoptingSession.current = true
          const pendingKey = remoteDraftKey(connectionId, cwd)
          const adoptedKey = remoteDraftKey(connectionId, effectiveCwd, nextStatus.externalSessionId)
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
        }
        if (nextStatus.externalSessionId && provider && (!context.externalSessionId || effectiveCwd !== cwd)) {
          onSessionAdopted(nextStatus.externalSessionId, provider, effectiveCwd)
        }
        if (nextStatus.state === 'settled' || nextStatus.state === 'failed') {
          setHistoryRevision((revision) => revision + 1)
          void refreshRemoteCatalog(connectionId)
          if (refreshedTerminalIntent !== activeIntent.intentId) {
            refreshedTerminalIntent = activeIntent.intentId
            void poll()
          }
        }
        if (nextStatus.scryRunId) {
          intentTrace = { runId: nextStatus.scryRunId, context: effectiveContext }
          await readHint(nextStatus.scryRunId, nextStatus.outputSeq, nextStatus.state, sequence, nextStatus.changed)
        } else { showTrace(null) }
        if (cancelled || sequence !== pollSequence.current) return
        setPollError(null)
        immediate = false
        setPollFresh(true)
      } catch (reason) {
        if (!cancelled && sequence === pollSequence.current) { setPollError(errorText(reason)); setPollFresh(false) }
      }
    }
    let pendingUpdate = false
    const poll = (): Promise<void> => {
      const active = pollInFlight.current
      if (active) {
        if (!pendingUpdate) {
          pendingUpdate = true
          void active.then(() => {
            pendingUpdate = false
            if (!cancelled && !document.hidden) void poll()
          })
        }
        return active
      }
      const request = readPoll().finally(() => { pollInFlight.current = undefined })
      pollInFlight.current = request
      return request
    }
    pollRef.current = poll
    let hiddenHistoryChanged = false
    const unsubscribe = window.scry.onDesktopRemoteUpdate?.((update) => {
      if (update.connectionId !== connectionId) return
      if (document.hidden) {
        hiddenHistoryChanged ||= update.history === true
        return
      }
      if (update.history) setHistoryRevision(revision => revision + 1)
      if (update.runs || update.stale) void poll()
    })
    const visibilityChanged = (): void => {
      if (document.hidden) {
        pollSequence.current += 1
        setPollFresh(false)
        return
      }
      if (hiddenHistoryChanged) {
        hiddenHistoryChanged = false
        setHistoryRevision(revision => revision + 1)
      }
      void poll()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    if (!document.hidden) void poll()
    return () => {
      cancelled = true
      unsubscribe?.()
      document.removeEventListener('visibilitychange', visibilityChanged)
      pollSequence.current += 1
      if (pollRef.current === poll) pollRef.current = undefined
    }
  }, [api, catalogReady, connectionId, connected, context, providerId, providerSelection, queueKey, queueStore, sessionActive, showTrace, traceDelta])
  return { controlProvider, updateControls }
}
