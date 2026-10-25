import { useCallback, useEffect, useMemo } from 'react'
import type { AgentInputAttachment, AgentQuestionResponse } from '@shared/runtime'
import { resolveTurnDiffReview, sessionNetDiffReview } from '../turn-diff'
import type { DesktopRemoteIntent } from '@shared/desktop-remote'
import type { DetectedAgent } from '../env'
import { attachmentsAfterSuccessfulSubmit, inputAttachments, type ComposerDraftAttachment } from '../composer-drafts'
import { QUEUE_COPY, REMOTE_ATTACHMENTS_COPY } from '../constants/copy'
import { refreshDesktopConnections } from '../hooks/useDesktopConnections'
import { refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import { historyTurns, shouldQueryUnknownIntent } from './DesktopRemote'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import type { FoundationState } from './RemoteChatFoundation'
import type { PresentationState } from './RemoteChatPresentation'
import type { RemoteChatProps } from './RemoteChat'
import { errorText, remoteAgentId } from './RemoteChatShared'

// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.


const POLL_MS = 1500

export function useRemoteChatExecution(foundation: FoundationState, presentation: PresentationState, { connectionId, draftStore, queueStore }: Pick<RemoteChatProps, 'connectionId' | 'draftStore' | 'queueStore'>) {
  const { api, connectionRefreshing, readError, connection, connected, host, catalogEntry, catalog, catalogReady, providerSelection, sessionId, setTurns, historyEvidence, setHistoryEvidence, setPollInterval, intents, setIntents, status, setStatus, error, setError, pollError, pollFresh, historyError, setHistoryError, submitting, setSubmitting, connecting, setConnecting, resolvingIntentId, setResolvingIntentId, unknownReceiptError, setUnknownReceiptError, generation, followLatest, provider, context, contextGeneration, draftKey, releaseAttachments, updateDraft, queueKey, queue, editingMessageId, setEditingMessageId, movedMessageId, setMovedMessageId, submissionInFlight } = foundation
  const { chosenModel, validEffort, validPermissionMode, displayTurns, chatNavigation, currentIntent, unknownReceiptBlocked, currentRunStatus, runActive, controlRunId, projectAvailable, contextAvailable } = presentation
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
    chatNavigation.cancel()
    followLatest.current = true
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
  const workspaceAvailable = projectAvailable
  const upgradeWorkbench = <div className="surface-unavailable"><b>需要更新远端 Scry</b><span>请更新 {host}，以启用文件编辑、源代码管理和终端。</span></div>
  return { submission, execute, attachmentBytes, attachmentError, submit, resolveUnknown, stop, answer, loadOlderHistory, connect, missingAgentId, agents, unavailableAgentIds, selectedAgentId, unknownIntent, noticeError, notice, diffReview, workspaceAvailable, upgradeWorkbench }
}
export type ExecutionState = ReturnType<typeof useRemoteChatExecution>
