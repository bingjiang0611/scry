import { useEffect } from 'react'
import type { AgentRunControls } from '@shared/runtime'
import { runStructuralTransition } from '../structural-motion'
import type { DesktopRemoteRunStatus } from '@shared/desktop-remote'
import { remoteQueueKey } from '../remote-prompt-queue'
import { refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import { useVisibilityPolling } from '../hooks/useVisibilityPolling'
import { mergeRemoteTrace } from '../remote-trace'
import { desktopProviderKey, historyTurns } from './DesktopRemote'
import { initialRemoteRunControls, readRemoteRunControls, remoteRunControlsKey, writeRemoteRunControls } from '../remote-run-controls'
import type { FoundationState } from './RemoteChatFoundation'
import type { RemoteChatProps } from './RemoteChat'
import { errorText, intentMatches, keepIfEqual, POLL_MS, QUIET_POLL_MAX_MS, remoteDraftKey } from './RemoteChatShared'

// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.


export type ControlsState = ReturnType<typeof useRemoteChatControls>

export function useRemoteChatControls(foundation: FoundationState, { connectionId, cwd, draftStore, queueStore, onSessionAdopted }: Pick<RemoteChatProps, 'connectionId' | 'cwd' | 'draftStore' | 'queueStore' | 'onSessionAdopted'>) {
  const { api, connected, catalog, catalogReady, providerSelection, sessionId, setSessionId, setControls, selectedProvider, selectedProviderContextKey, initializedControlsContext, setTurns, setHistoryEvidence, setHistoryLoading, historyRevision, setHistoryRevision, traceViewRef, showTrace, pollIntervalMs, applyPollInterval, setPollInterval, lastPollKey, setRunStatus, setForeignRun, foreignRunRef, setIntents, setPollError, setPollFresh, setHistoryError, generation, provider, providerId, context, presentedHistoryContext, controlContextKey, contextKey, sessionActive, traceDelta, pollSequence, pollInFlight, pollRef, adoptingSession, adoptedIntent, queueKey } = foundation
  const controlProvider = catalog?.providerDiscovery !== 2 ? provider
    : selectedProvider && selectedProviderContextKey === controlContextKey && desktopProviderKey(selectedProvider) === providerSelection ? selectedProvider : undefined
  // Initialize once per execution context. Refresh validates rather than silently
  // replacing a user's selected model, effort, or permission with new defaults.
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
    const sequence = ++generation.current
    setHistoryError(null)
    setHistoryLoading(true)
    void api.history(connectionId, context).then((history) => {
      if (sequence !== generation.current) return
      const parsed = historyTurns(history)
      const commit = (): void => {
        setTurns(parsed)
        setHistoryEvidence({ status: history.status, reason: history.reason, hasOlder: history.hasOlder, before: history.before, snapshot: history.snapshot })
        presentedHistoryContext.current = context
      }
      if (presentedHistoryContext.current !== context && parsed.length > 0) runStructuralTransition('session', commit)
      else commit()
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

  return { controlProvider, updateControls }
}
