import { useEffect, useLayoutEffect, useMemo } from 'react'
import type { TraceEvent } from '@shared/trace'
import { chatBottomStickinessAfterScroll, observeChatBottomLayout, scrollChatToBottomIfNeeded } from '../chat-scroll'
import type { RemoteProviderRef } from '@shared/desktop-remote'
import type { Turn } from '../format'
import { useChatNavigation } from '../hooks/useChatNavigation'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import type { FoundationState } from './RemoteChatFoundation'
import type { RemoteChatProps } from './RemoteChat'
import { intentMatches, remoteControlsValid, remoteRunControlCatalog } from './RemoteChatShared'

// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.


export function useRemoteChatPresentation(foundation: FoundationState, controlProvider: RemoteProviderRef | undefined, { scrollRef, cwd, queueStore }: Pick<RemoteChatProps, 'scrollRef' | 'cwd' | 'queueStore'>) {
  const { connectionRefreshing, connection, connected, host, catalogEntry, catalog, catalogReady, sessionId, controls, providerControlsError, turns, setSelected, historyEvidence, historyLoading, activeRun, runStatus, foreignRun, intents, pollError, pollFresh, historyError, openingLatest, followLatest, provider, providerId, context, contextKey, catalogSession, adoptedIntent, draftKey } = foundation
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

  const chatNavigation = useChatNavigation(scrollRef, true, displayTurns.length, contextKey)
  const openTurnInChat = (runId: string, event?: TraceEvent | null, target: 'turn' | 'event' = 'turn'): void => {
    openingLatest.current = false
    followLatest.current = false
    if (event) setSelected(event)
    chatNavigation.navigate(runId, target === 'event' ? event?.id : undefined)
  }

  // This mounted remote context owns its scroll intent, independently of the
  // last local/remote session. Follow late Markdown/image layout until the
  // reader deliberately scrolls away from the latest message.
  useEffect(() => {
    const history = scrollRef.current
    if (!history) return
    let previous = { scrollTop: history.scrollTop, scrollHeight: history.scrollHeight, clientHeight: history.clientHeight }
    const onScroll = (): void => {
      if (chatNavigation.active.current) return
      const position = { scrollTop: history.scrollTop, scrollHeight: history.scrollHeight, clientHeight: history.clientHeight }
      const nearLatest = chatBottomStickinessAfterScroll(position, openingLatest.current)
      // Removing a notice can grow the viewport and clamp scrollTop upward.
      // Content may then grow before that scroll event arrives. That exact
      // viewport clamp is not a reader scrolling away from the latest message.
      const viewportClamp = position.clientHeight > previous.clientHeight &&
        Math.abs(position.scrollTop - Math.max(0, previous.scrollHeight - position.clientHeight)) <= 1
      if (nearLatest || (position.scrollTop < previous.scrollTop && !viewportClamp)) followLatest.current = nearLatest
      previous = position
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
      if (!openingLatest.current || chatNavigation.active.current) return
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

  return { runControlCatalog, chosenModel, availableEfforts, validEffort, validPermissionMode, displayTurns, chatNavigation, openTurnInChat, currentIntent, unknownReceiptBlocked, currentRunStatus, runActive, controlRunId, projectAvailable, sessionArchived, contextAvailable, sendBlockedReason }
}

export type PresentationState = ReturnType<typeof useRemoteChatPresentation>
