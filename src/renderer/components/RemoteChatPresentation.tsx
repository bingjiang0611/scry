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



export function useRemoteChatPresentation(foundation: FoundationState, controlProvider: RemoteProviderRef | undefined, { scrollRef, cwd, queueStore, surface }: Pick<RemoteChatProps, 'scrollRef' | 'cwd' | 'queueStore' | 'surface'>) {
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
    if (!surface.primaryVisible) {
      surface.onAction({ type: 'hide' })
      scrollRef.current?.focus({ preventScroll: true })
    }
    chatNavigation.navigate(runId, target === 'event' ? event?.id : undefined)
  }

  useEffect(() => {
    const history = scrollRef.current
    if (!history) return
    let previous = { scrollTop: history.scrollTop, scrollHeight: history.scrollHeight, clientHeight: history.clientHeight }
    const onScroll = (): void => {
      if (chatNavigation.active.current) return
      const position = { scrollTop: history.scrollTop, scrollHeight: history.scrollHeight, clientHeight: history.clientHeight }
      const nearLatest = chatBottomStickinessAfterScroll(history, openingLatest.current)
      const viewportClamp = position.clientHeight > previous.clientHeight &&
        Math.abs(position.scrollTop - Math.max(0, previous.scrollHeight - position.clientHeight)) <= 1
      if (nearLatest || (position.scrollTop < previous.scrollTop && !viewportClamp)) followLatest.current = nearLatest
      previous = position
    }
    history.addEventListener('scroll', onScroll, { passive: true })
    const unobserve = observeChatBottomLayout(history, () => openingLatest.current || followLatest.current)
    return () => { history.removeEventListener('scroll', onScroll); unobserve?.() }
  }, [scrollRef, contextKey])
  useLayoutEffect(() => {
    scrollChatToBottomIfNeeded(scrollRef.current, openingLatest.current || followLatest.current)
    if (!openingLatest.current || historyLoading || (sessionId && !historyEvidence && !historyError)) return
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
  const unknownReceiptBlocked = intents.some((intent) => intent.status === 'unknown')
  const currentRunStatus = runStatus?.runId === currentIntent?.runId ? runStatus : null
  const runActive = Boolean(foreignRun) || Boolean(currentIntent && (currentIntent.status === 'unknown' ||
    (currentIntent.runId && currentRunStatus?.state !== 'settled' && currentRunStatus?.state !== 'failed')))
  const controlRunId = currentIntent?.runId ?? foreignRun?.runId
  const projectAvailable = catalog?.projects.some((project) => project.path === cwd) ?? false
  const sessionArchived = Boolean(catalogSession?.archivedAt ?? catalog?.sessions.find(item => item.externalSessionId === sessionId && item.cwd === cwd &&
    item.providerId === providerId && (item.agentProfileId ?? '') === (provider?.agentProfileId ?? ''))?.archivedAt)
  const contextAvailable = connected && catalogReady && pollFresh && Boolean(provider?.available) && remoteControlsValid(controlProvider, controls) && projectAvailable && !sessionArchived
  useEffect(() => {
    if (sessionArchived) queueStore.clearSession(draftKey)
  }, [sessionArchived, queueStore, draftKey])

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
