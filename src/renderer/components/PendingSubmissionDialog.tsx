import { useId, useRef, useState } from 'react'
import type { AgentInputAttachment } from '@shared/runtime'
import type { ComposerPendingSubmission } from '../composer-drafts'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { PendingRecoveryState } from '../composer-pending'
import { ImageLightbox, attachmentSrc } from './ChatTurnUser'
import { ModalFrame } from './ModalFrame'

/**
 * Read-only view of one submitted-but-unresolved send.
 *
 * The durable receipt is the only copy of what was submitted: the composer has already
 * given the text and images up, and the editable draft next to it belongs to the next
 * message. So this dialog reads `pending` and nothing else — no draft, no transcript and
 * no live run — which is what keeps the submitted payload unchanged while the user keeps
 * typing. It never resends: the only action is closing.
 *
 * The text is rendered verbatim rather than through Markdown, because a receipt has to
 * show the exact characters that were submitted. Images reopen the existing lightbox, so
 * there is one image-inspection surface in the product rather than a second one here.
 */
export function PendingSubmissionDialog({ pending, state, onClose }: {
  pending: ComposerPendingSubmission
  state: PendingRecoveryState
  onClose: () => void
}) {
  const titleId = `pending-submission-title-${useId().replaceAll(':', '')}`
  const closeRef = useRef<HTMLButtonElement>(null)
  const [preview, setPreview] = useState<AgentInputAttachment | null>(null)
  const images = pending.attachments
  return <>
    <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="pending-submission-modal"
      onClose={onClose}>
      <section className="pending-submission" data-pending-content={pending.commandId}
        data-pending-content-state={state}>
        <header className="pending-submission-header">
          <div>
            <h3 id={titleId}>{SIDE_CHAT_COPY.pendingInspectTitle}</h3>
            <p>{state === 'not_sent' ? SIDE_CHAT_COPY.pendingStates.notSent : SIDE_CHAT_COPY.pendingStates.unresolved}</p>
          </div>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}
            aria-label={SIDE_CHAT_COPY.pendingInspectClose}>{SIDE_CHAT_COPY.pendingInspectClose}</button>
        </header>
        <div className="pending-submission-body">
          <p className="pending-submission-label">{SIDE_CHAT_COPY.pendingInspectTextLabel}</p>
          {pending.prompt
            ? <pre className="pending-submission-text" data-pending-content-text="">{pending.prompt}</pre>
            : <p className="pending-submission-empty">{SIDE_CHAT_COPY.pendingInspectNoText}</p>}
          {images.length > 0 && <>
            <p className="pending-submission-label">{SIDE_CHAT_COPY.pendingInspectImagesLabel}</p>
            <div className="pending-submission-images">
              {images.map((attachment, index) => <figure className="pending-submission-image" key={`${attachment.name}:${index}`}>
                <button type="button" className="user-attachment" data-pending-content-image={attachment.name}
                  onClick={() => setPreview(attachment)} title={attachment.name}
                  aria-haspopup="dialog" aria-expanded={preview === attachment}>
                  <img src={attachmentSrc(attachment)} alt={attachment.name} loading="lazy" decoding="async" />
                </button>
                <figcaption title={attachment.name}>{attachment.name}</figcaption>
              </figure>)}
            </div>
          </>}
        </div>
        <footer className="pending-submission-footer">
          <p>{SIDE_CHAT_COPY.pendingInspectReadonly}</p>
        </footer>
      </section>
    </ModalFrame>
    {preview && <ImageLightbox attachment={preview} onClose={() => setPreview(null)} />}
  </>
}
