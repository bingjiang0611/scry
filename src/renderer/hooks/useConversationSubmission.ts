import { useRef, useState } from 'react'
import type { ConversationSubmissionRequest, ConversationSubmissionResult, ConversationTargetRequest } from '@shared/conversation-api'
import type { TaskCommandCatalog } from '@shared/task-command'
import { attachmentsAfterSuccessfulSubmit, inputAttachments, type ComposerDraftStore } from '../composer-drafts'
import { prepareConversationSend } from '../conversation-handoff'
import { CONVERSATION_COMMAND_COPY as copy } from '../constants/conversation-command-copy'
import { WORKFLOW_SIZE_COPY } from '../constants/copy'
import { WORKFLOW_MODE_COPY } from '@shared/constants/workflow-mode-copy'
import type { WorkflowMessageOverride } from '@shared/workflow-mode'

type Attempt = { request: ConversationSubmissionRequest; attachments: Array<{ id: string; previewUrl: string }> }
type Control = Extract<ConversationSubmissionResult, { kind: 'control' }>
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Native-context negotiation is a known, effect-free response. An exception
 * after submit is not: retain the exact command instead of inventing a retry. */
export function useConversationSubmission(options: {
  conversationId: string
  draftStore: ComposerDraftStore
  draftKey: string
  readiness: () => { revision: number | undefined; blocked: boolean }
  getTarget: () => ConversationTargetRequest
  isMounted: () => boolean
  refresh: () => Promise<unknown>
  onChanged: () => void
  showLatest: () => void
  onControl: (control: Control) => void
}) {
  const [attempt, setAttempt] = useState<Attempt>()
  const [attemptReadback, setAttemptReadback] = useState(false)
  const [selectedCommandId, setSelectedCommandId] = useState<string>()
  const [workflowOverride, setWorkflowOverride] = useState<WorkflowMessageOverride>()
  const [sourceRequest, setSourceRequest] = useState<TaskCommandCatalog>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [working, setWorking] = useState(false)
  const busyRef = useRef(false)
  const { draftStore, draftKey } = options
  const consume = (submitted: Attempt): void => {
    const ids = new Set(submitted.attachments.map(attachment => attachment.id))
    draftStore.update(current => {
      const draft = current.get(draftKey)
      if (!draft) return current
      const remaining = { input: draft.input === submitted.request.prompt ? '' : draft.input,
        attachments: attachmentsAfterSuccessfulSubmit(draft.attachments, ids) }
      const next = new Map(current)
      if (remaining.input || remaining.attachments.length) next.set(draftKey, remaining)
      else next.delete(draftKey)
      return next
    })
    for (const attachment of submitted.attachments) if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
  }
  const send = async (original?: Attempt): Promise<void> => {
    const draft = draftStore.getSnapshot().get(draftKey)
    const prompt = draft?.input ?? ''
    const attachments = draft?.attachments ?? []
    const readiness = options.readiness()
    if (busyRef.current || (!original && (readiness.blocked || attempt || readiness.revision === undefined || (!prompt.trim() && !attachments.length)))) return
    busyRef.current = true
    setWorking(true)
    setError(undefined)
    setNotice(undefined)
    let submitted = original
    let outcomeUnknown = false
    try {
      submitted ??= { request: { conversationId: options.conversationId, expectedRevision: readiness.revision!,
        commandId: crypto.randomUUID(), prompt, ...(selectedCommandId ? { selectedCommandId } : {}),
        message: { ...(attachments.length ? { attachments: inputAttachments(attachments) } : {}),
          ...(workflowOverride ? { workflowOverride } : {}) } },
        attachments: attachments.map(({ id, previewUrl }) => ({ id, previewUrl })) }
      setAttempt(submitted)
      setAttemptReadback(false)
      outcomeUnknown = true
      let result = await window.scry.conversations.submit(submitted.request)
      if (!options.isMounted()) { if (result.kind === 'direct') consume(submitted); return }
      if (result.kind === 'needs_native_context') {
        outcomeUnknown = false
        setAttempt(undefined)
        const native = await prepareConversationSend(window.scry.conversations, options.conversationId,
          options.getTarget(), submitted.request.prompt, submitted.request.commandId, submitted.request.message?.attachments)
        if (!options.isMounted()) return
        const { conversationId: _id, expectedRevision, commandId: _command, prompt: _prompt, ...context } = native
        submitted = { ...submitted, request: { ...submitted.request, expectedRevision, message: { ...submitted.request.message, ...context } } }
        setAttempt(submitted)
        outcomeUnknown = true
        result = await window.scry.conversations.submit(submitted.request)
        if (!options.isMounted()) { if (result.kind === 'direct') consume(submitted); return }
      }
      outcomeUnknown = false
      setAttempt(undefined)
      if (result.kind === 'needs_command_source') { setSelectedCommandId(undefined); setSourceRequest(result.catalog); return }
      if (result.kind === 'rejected') { setError(result.error); return }
      if (result.kind === 'needs_native_context') { setError(copy.invalidNegotiation); return }
      // Only an accepted direct turn or control consumes a one-message choice.
      // Source negotiation, rejection and unknown ACKs retain the exact request.
      setWorkflowOverride(undefined)
      if (result.kind === 'control') {
        options.onControl(result)
        if (result.action === 'open_workflow_planner' || result.action === 'open_workflow_template' || result.action === 'open_workflow_routed') return
        consume(submitted)
        setSelectedCommandId(undefined)
        if (result.action === 'size_updated') setNotice(copy.sizeUpdated(WORKFLOW_SIZE_COPY.values[result.snapshot.value]))
        if (result.action === 'mode_updated') setNotice(WORKFLOW_MODE_COPY.updated(result.mode))
        return
      }
      consume(submitted)
      setSelectedCommandId(undefined)
      options.showLatest()
      setNotice(result.disposition === 'duplicate' ? copy.duplicate : undefined)
      options.onChanged()
      await options.refresh().catch(error => { if (options.isMounted()) setError(copy.readFailed(message(error))) })
    } catch (error) {
      if (options.isMounted()) {
        setError(message(error))
        if (outcomeUnknown) {
          setNotice(copy.unknownResult)
          try { setAttemptReadback(Boolean(await options.refresh())) } catch (readError) { setError(copy.readAlsoFailed(message(error), message(readError))) }
        } else setAttempt(undefined)
      }
    } finally { busyRef.current = false; if (options.isMounted()) setWorking(false) }
  }
  return { attempt, setAttempt, attemptReadback, selectedCommandId, setSelectedCommandId, workflowOverride, setWorkflowOverride, sourceRequest,
    error, setError, notice, setNotice, working, setWorking, busyRef, send }
}
