import { useId, useState } from 'react'
import type { WorkspacePrepareProgress } from '@shared/workspace-selection'
import { workspaceCopy as copy } from '../constants/workspace-copy'
import { Disclosure } from './Disclosure'
import { Button } from './primitives/Button'
import { Icon } from './primitives/Icon'
import './worktree-setup-card.css'

export interface WorktreeSetupCardProps {
  progress: WorkspacePrepareProgress
  cancelling?: boolean
  onCancel?: () => void
}

function StepBadge({ status }: { status: 'done' | 'active' | 'pending' }) {
  if (status === 'done') {
    return (
      <span className="worktree-setup-step-icon is-done" aria-hidden="true">
        <Icon name="check" />
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span className="worktree-setup-step-icon is-active" aria-hidden="true">
        <span className="worktree-setup-spinner" />
      </span>
    )
  }
  return <span className="worktree-setup-step-icon is-pending" aria-hidden="true" />
}

export function WorktreeSetupCard({ progress, cancelling = false, onCancel }: WorktreeSetupCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const isCancelling = cancelling || progress.stage === 'cancelling'
  const prepareStatus: 'done' | 'active' = progress.workspacePrepared ? 'done' : 'active'
  const checkoutDone = progress.stage === 'verifying' || progress.stage === 'completed'
  const checkoutStatus: 'done' | 'active' | 'pending' = checkoutDone
    ? 'done'
    : progress.stage === 'checking_out'
      ? 'active'
      : 'pending'
  const showProgressBar = progress.stage === 'checking_out' || (checkoutDone && progress.checkout != null)
  const percent = progress.checkout?.percent
  const determinate = typeof percent === 'number'
  const displayPercent = determinate ? (checkoutDone ? 100 : percent) : undefined
  const canCancel = Boolean(onCancel) && progress.cancellable && !isCancelling

  const detailLines: string[] = []
  if (progress.branch) detailLines.push(copy.setupBranchMeta(progress.branch))
  if (progress.baseRef) detailLines.push(copy.setupBaseMeta(progress.baseRef))
  if (progress.checkout) {
    detailLines.push(copy.setupCheckoutFilesMeta(progress.checkout.completed, progress.checkout.total))
  }
  for (const line of progress.details) detailLines.push(line)

  return (
    <section
      className="worktree-setup"
      role="status"
      aria-live="polite"
      aria-label={isCancelling ? copy.cancellingWorktree : copy.creatingWorktree}
      data-worktree-stage={progress.stage}
    >
      <div className="worktree-setup-heading">
        <Icon name="branch" />
        <span>{isCancelling ? copy.cancellingWorktree : copy.creatingWorktree}</span>
      </div>
      <div className="worktree-setup-card">
        <div className="worktree-setup-steps">
          <div className={`worktree-setup-step is-${prepareStatus}`}>
            <StepBadge status={prepareStatus} />
            <span className="worktree-setup-step-label">{copy.stepPreparingWorkspace}</span>
          </div>
          <div className={`worktree-setup-step is-${checkoutStatus}`}>
            <StepBadge status={checkoutStatus} />
            <span className="worktree-setup-step-label">{copy.stepCheckingOutFiles}</span>
            {showProgressBar && (
              <div className="worktree-setup-progress">
                <div
                  className={`worktree-setup-track${determinate ? '' : ' is-indeterminate'}`}
                  role="progressbar"
                  aria-label={copy.stepCheckingOutFiles}
                  aria-valuemin={determinate ? 0 : undefined}
                  aria-valuemax={determinate ? 100 : undefined}
                  aria-valuenow={displayPercent}
                >
                  <span
                    className="worktree-setup-fill"
                    style={determinate ? { transform: `scaleX(${(displayPercent ?? 0) / 100})` } : undefined}
                  />
                </div>
                {displayPercent !== undefined && (
                  <span className="worktree-setup-percent">{displayPercent}%</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="worktree-setup-footer">
          <button
            type="button"
            className="worktree-setup-details-toggle"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen(open => !open)}
          >
            <Icon name={detailsOpen ? 'chevronDown' : 'chevronRight'} />
            <span>{detailsOpen ? copy.hideDetails : copy.moreDetails}</span>
          </button>
          {onCancel && (
            <Button
              variant="quiet"
              size="sm"
              className="worktree-setup-cancel"
              onClick={onCancel}
              disabled={!canCancel}
              aria-busy={isCancelling || undefined}
            >
              <Icon name="x" />
              <span>{isCancelling ? copy.cancellingSetup : copy.cancelSetup}</span>
            </Button>
          )}
        </div>
        <Disclosure open={detailsOpen}>
          {() => (
            <div id={detailsId} className="worktree-setup-details">
              {detailLines.length > 0 ? (
                <ul className="worktree-setup-detail-list">
                  {detailLines.map((line, index) => (
                    <li key={`${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="worktree-setup-detail-empty">{copy.setupNoDetails}</p>
              )}
            </div>
          )}
        </Disclosure>
      </div>
    </section>
  )
}
