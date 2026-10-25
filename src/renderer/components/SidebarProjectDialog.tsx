import { useRef, useState } from 'react'
import type { ProjectMeta } from '../env'
import { MODAL_COPY, SIDEBAR_PROJECT_COPY as copy } from '../constants/copy'
import { ModalFrame, requestModalClose } from './Modals'
import { ModalCloseButton } from './primitives/ModalCloseButton'

export function ProjectDialog({
  mode,
  project,
  onClose,
  onRename,
  onRemove
}: {
  mode: 'rename' | 'remove'
  project: ProjectMeta
  onClose: () => void
  onRename: (name: string) => void | Promise<void>
  onRemove: () => void | Promise<void>
}) {
  const [name, setName] = useState(project.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = `project-dialog-${mode}`
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={mode === 'rename' ? inputRef : undefined} className="project-dialog" onClose={onClose}>
      <div className="modal-head">
        <b id={titleId}>{mode === 'rename' ? copy.rename : copy.removeTitle(project.name)}</b>
        <ModalCloseButton aria-label={MODAL_COPY.close} onClick={() => requestModalClose()}>{copy.closeGlyph}</ModalCloseButton>
      </div>
      {mode === 'rename' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const next = name.trim()
            if (next) void onRename(next)
          }}
        >
          <div className="project-dialog-body">
            <label>
              <span>{copy.displayName}</span>
              <input ref={inputRef} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            </label>
            <code>{project.cwd}</code>
          </div>
          <div className="project-dialog-actions">
            <button type="button" className="btn" onClick={() => requestModalClose()}>{copy.cancel}</button>
            <button type="submit" className="btn primary" disabled={!name.trim()}>{copy.save}</button>
          </div>
        </form>
      ) : (
        <>
          <div className="project-dialog-body">
            <p>{copy.removeHint}</p>
            <code>{project.cwd}</code>
          </div>
          <div className="project-dialog-actions">
            <button type="button" className="btn" onClick={() => requestModalClose()}>{copy.cancel}</button>
            <button type="button" className="btn project-remove-confirm" onClick={() => void onRemove()}>{copy.remove}</button>
          </div>
        </>
      )}
    </ModalFrame>
  )
}
