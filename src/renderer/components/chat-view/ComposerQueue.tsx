import type { ChatViewProps } from './types'
import { Icon } from '../primitives/Icon'
import { steerStateForMessage } from '../../steer'
import { QUEUE_COPY } from '../../constants/copy'

type ComposerQueueProps = Pick<ChatViewProps,
  'queuedPrompts'
  | 'steerEvidenceByMessageId'
  | 'steerInFlightMessageIds'
  | 'steerCapability'
  | 'editingQueuedId'
  | 'movedQueuedId'
  | 'onSteerQueuedPrompt'
  | 'onEditQueuedPrompt'
  | 'onCancelQueuedPromptEdit'
  | 'onRemoveQueuedPrompt'
> & {
  input: string
  draftAttachments: ChatViewProps['draftAttachments']
  nextQueuedMessageId: string | null
  busy: boolean
}

export function ComposerQueue({
  queuedPrompts,
  steerEvidenceByMessageId = new Map(),
  steerInFlightMessageIds = new Set(),
  steerCapability = null,
  editingQueuedId = null,
  movedQueuedId = null,
  onSteerQueuedPrompt,
  onEditQueuedPrompt,
  onCancelQueuedPromptEdit,
  onRemoveQueuedPrompt,
  input,
  draftAttachments,
  nextQueuedMessageId,
  busy
}: ComposerQueueProps) {
  return <>
        {queuedPrompts.length > 0 && (
          <div className="prompt-queue" aria-label={QUEUE_COPY.listLabel(queuedPrompts.length)}>
            <div className="queue-title">
              <span className="queue-title-main">
                <Icon name="clock" />
                <span>{QUEUE_COPY.title}</span>
                <span className="queue-count">{queuedPrompts.length}</span>
              </span>
              <span className="queue-hint">{QUEUE_COPY.hint}</span>
            </div>
            <div className="queue-list" role="list">
              {queuedPrompts.map((prompt, index) => {
                const evidence = steerEvidenceByMessageId.get(prompt.messageId)
                const steerState = steerStateForMessage(prompt.steer, evidence)
                const pending = steerState?.status === 'pending'
                const unknown = steerState?.status === 'unknown'
                const rejected = steerState?.status === 'rejected'
                const editing = editingQueuedId === prompt.messageId
                const hasConcurrentSteer = steerInFlightMessageIds.size > 0
                const capabilityReason = !busy
                  ? QUEUE_COPY.steerTitleEnded
                  : steerCapability == null
                    ? QUEUE_COPY.steerTitleWaiting
                    : steerCapability.status === 'unavailable'
                      ? steerCapability.reason
                      : prompt.attachments.length > 0 && !steerCapability.attachments
                        ? QUEUE_COPY.steerTitleNoAttachments
                        : undefined
                const steerDisabled = pending || unknown || steerState?.status === 'unavailable' ||
                  capabilityReason != null || hasConcurrentSteer || editing
                const steerLabel = pending ? QUEUE_COPY.steerPending : rejected ? QUEUE_COPY.steerRetry : QUEUE_COPY.steer
                const steerTitle = pending
                  ? QUEUE_COPY.steerTitlePending
                  : unknown
                    ? QUEUE_COPY.steerTitleUnknown(steerState.message)
                    : rejected
                      ? QUEUE_COPY.steerTitleRejected(steerState.message)
                      : steerState?.status === 'unavailable'
                        ? steerState.message ?? QUEUE_COPY.steerUnavailable('')
                        : capabilityReason ?? QUEUE_COPY.steerTitle
                const editDraftBlocked = input.trim().length > 0 || draftAttachments.length > 0
                const editDisabled = editing || pending || unknown || editDraftBlocked || !onEditQueuedPrompt
                const editTitle = pending
                  ? QUEUE_COPY.editTitlePending
                  : unknown
                    ? QUEUE_COPY.editTitleUnknown
                    : editDraftBlocked
                      ? QUEUE_COPY.editTitleDraft
                      : QUEUE_COPY.editTitle
                // 下一个真正会跑的是第一条没在编辑中的消息：跳过编辑中的行。
                const next = nextQueuedMessageId === prompt.messageId
                return (
                  <div
                    className={`queue-item${next ? ' is-next' : ''}${editing ? ' is-editing' : ''}${pending ? ' is-steer-pending' : ''}${unknown ? ' is-steer-unknown' : ''}${rejected ? ' is-steer-rejected' : ''}`}
                    role="listitem"
                    key={prompt.messageId}
                  >
                    <span className="queue-index" aria-hidden="true">{index + 1}</span>
                    <span className="queue-text" title={prompt.text}>
                      {prompt.text || QUEUE_COPY.imagesOnly(prompt.attachments.length)}
                      {rejected && <small className="queue-steer-reason">{steerState.message ?? QUEUE_COPY.reasonRejected}</small>}
                      {steerState?.status === 'unavailable' && <small className="queue-steer-reason">{steerState.message ?? QUEUE_COPY.reasonUnavailable}</small>}
                      {unknown && <small className="queue-steer-reason">{steerState.message ?? QUEUE_COPY.reasonUnknown}</small>}
                      {movedQueuedId === prompt.messageId && <small className="queue-moved">{QUEUE_COPY.editedMoved}</small>}
                    </span>
                    {prompt.attachments.length > 0 && (
                      <span className="queue-attach" title={QUEUE_COPY.attachmentsTitle(prompt.attachments.map((a) => a.name))}>
                        <Icon name="image" /> {prompt.attachments.length}
                      </span>
                    )}
                    {editing ? (
                      <button
                        type="button"
                        className="queue-edit-cancel"
                        onClick={() => onCancelQueuedPromptEdit?.()}
                        aria-label={`${QUEUE_COPY.cancelEdit}：队列第 ${index + 1} 条消息`}
                        title={QUEUE_COPY.cancelEdit}
                      >
                        {QUEUE_COPY.cancelEdit}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`queue-steer${pending ? ' is-pending' : ''}`}
                          onClick={() => onSteerQueuedPrompt?.(prompt.messageId)}
                          disabled={steerDisabled || !onSteerQueuedPrompt}
                          title={steerTitle}
                          aria-label={QUEUE_COPY.steerLabel(steerLabel, index + 1)}
                          aria-busy={pending}
                        >
                          <span aria-hidden="true">↳</span> {steerLabel}
                        </button>
                        <button
                          type="button"
                          className="queue-edit"
                          onClick={() => onEditQueuedPrompt?.(prompt.messageId)}
                          disabled={editDisabled}
                          title={editTitle}
                          aria-label={QUEUE_COPY.editLabel(index + 1)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          className="queue-remove"
                          onClick={() => onRemoveQueuedPrompt(prompt.messageId)}
                          disabled={pending || unknown}
                          title={pending ? QUEUE_COPY.removeTitlePending : unknown ? QUEUE_COPY.removeTitleUnknown : QUEUE_COPY.remove}
                          aria-label={QUEUE_COPY.removeLabel(index + 1)}
                        >
                          <Icon name="x" />
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
            {steerCapability?.status === 'unavailable' && (
              <div className="queue-steer-capability" role="note">{QUEUE_COPY.steerUnavailable(steerCapability.reason)}</div>
            )}
          </div>
        )}
  </>
}
