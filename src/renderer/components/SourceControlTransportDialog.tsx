import type { ScRemote, ScRepository } from '@shared/source-control'
import { sourceControlTransportCopy as copy } from '../constants/source-control-copy'
import { ModalFrame, requestModalClose } from './Modals'

export function SourceControlTransportDialog({
  repo, action, remote, destination, disabled, blocker, labelledBy,
  onRemoteChange, onClose, onConfirm
}: {
  repo: ScRepository
  action: 'push' | 'fetch'
  remote: string
  destination?: ScRemote
  disabled: boolean
  blocker: string | null | undefined
  labelledBy: string
  onRemoteChange: (remote: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  return <ModalFrame labelledBy={labelledBy} onClose={onClose}>
    <h2 id={labelledBy}>{copy.title(action)}</h2>
    <label>{copy.remote}<select value={remote} onChange={event => onRemoteChange(event.target.value)}>
      <option value="" disabled>{copy.chooseRemote}</option>
      {repo.remotes.map(item => <option key={item.name}>{item.name}</option>)}
    </select></label>
    <pre className="sc-confirm-detail">{(action === 'push' ? destination?.pushUrls : destination?.fetchUrls)?.join('\n') ?? copy.noRemote}</pre>
    <p>{copy.detail(action, repo)}</p>
    {blocker && <p className="sc-notice" role="alert">{blocker}</p>}
    {!repo.remotes.length && <p className="sc-notice">{copy.missingRemote}</p>}
    <div className="sc-actions"><button onClick={() => requestModalClose()}>{copy.cancel}</button>
      <button className="sc-primary" disabled={disabled || !!blocker || !remote || (action === 'push' && (!repo.branch || !repo.head))}
        onClick={onConfirm}>{copy.confirm(action, repo.branch)}</button>
    </div>
  </ModalFrame>
}
