import type { ScFile } from '@shared/source-control'
import { sourceControlFileCopy as copy } from '../constants/source-control-copy'
import { basename } from '../format'
import { isStaged } from '../source-control-workflow'

export function SourceControlFileRow({
  file, buttonId, selected, included, busy, unstageDisabled, onToggle, onInspect, onUnstage
}: {
  file: ScFile
  buttonId: string
  selected: boolean
  included: boolean
  busy: boolean
  unstageDisabled: boolean
  onToggle: () => void
  onInspect: () => void
  onUnstage: () => void
}) {
  return <div className={`sc-file-row${selected ? ' selected' : ''}`}>
    <input type="checkbox" aria-label={copy.include(file.path)} checked={included}
      disabled={busy || isStaged(file)} onChange={onToggle} />
    <button id={buttonId} className="sc-file-name" title={file.path} aria-pressed={selected} onClick={onInspect}>
      <strong>{basename(file.path)}</strong>
      <small>{isStaged(file) ? file.worktree !== '.' ? copy.partiallyStaged : copy.staged : file.path}</small>
    </button>
    {isStaged(file)
      ? <button className="sc-unstage" aria-label={copy.unstage(file.path)} disabled={unstageDisabled} onClick={onUnstage}>{copy.minus}</button>
      : <span className="sc-file-status">{file.untracked ? copy.untracked : file.worktree}</span>}
  </div>
}
