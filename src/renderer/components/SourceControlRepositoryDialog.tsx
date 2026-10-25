import type { ScRepository } from '@shared/source-control'
import { sourceControlRepositoryCopy as copy } from '../constants/source-control-copy'
import { ModalFrame } from './Modals'

export function SourceControlRepositoryDialog({ repo, labelledBy, onClose }: {
  repo: ScRepository
  labelledBy: string
  onClose: () => void
}) {
  return <ModalFrame labelledBy={labelledBy} onClose={onClose}>
    <h2 id={labelledBy}>{copy.title}</h2>
    <div className="sc-identity">
      <small title={repo.root}>{repo.root}</small><code>{copy.head(repo.head)}</code>
      <p>{copy.branch(repo)}</p><p>{copy.tracking(repo)}</p><p>{copy.observedAt(repo.observedAt)}</p>
    </div>
    <p className="sc-muted">{copy.note}</p><button onClick={onClose}>{copy.close}</button>
  </ModalFrame>
}
