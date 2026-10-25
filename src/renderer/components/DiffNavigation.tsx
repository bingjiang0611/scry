import { useId, useState, type ReactNode } from 'react'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import type { DiffCommitHistory } from '../hooks/useDiffCommitHistory'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'

function Commits({ history }: { history: DiffCommitHistory }) {
  const id = useId()
  const commits = history.page?.commits ?? []
  const [cursor, setCursor] = useState(0)
  const rows = useFixedVirtualRows(commits.length, 44)
  const active = Math.min(cursor, commits.length - 1)
  return <div className="diff-commits">
    <div ref={rows.ref} className="diff-virtual-commits" role="listbox" tabIndex={0} aria-label={copy.commits}
      aria-activedescendant={active >= rows.start && active < rows.end ? `${id}-${active}` : undefined}
      onKeyDown={event => {
        if (!commits.length) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void history.select(commits[active].hash)
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? commits.length - 1
            : Math.max(0, Math.min(commits.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))
          setCursor(next)
          rows.reveal(next)
        }
      }}>
      <div style={{ height: rows.totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: rows.offset, left: 0, right: 0 }}>
          {commits.slice(rows.start, rows.end).map((commit, index) => <button type="button" role="option" tabIndex={-1}
            className={active === rows.start + index ? 'is-cursor' : ''} key={commit.hash} id={`${id}-${rows.start + index}`}
            aria-selected={history.selected === commit.hash} aria-posinset={rows.start + index + 1} aria-setsize={commits.length}
            onClick={() => { setCursor(rows.start + index); void history.select(commit.hash) }} title={commit.subject}>
            <span className="diff-commit-subject">{commit.subject}</span>
            <span className="diff-commit-meta">{copy.commitMeta(commit.hash, commit.author)}</span>
          </button>)}
        </div>
      </div>
    </div>
    {!history.available || history.page?.failed ? <div className="diff-history-status" role="status">{copy.commitsUnavailable}
      {history.available && <button type="button" onClick={() => void history.load(history.page?.nextOffset ?? 0)}>{copy.retryCommits}</button>}
    </div> : !history.page || history.page.pending ? <div className="diff-history-status" role="status">{copy.commitPending}</div>
      : !commits.length ? <div className="diff-history-status">{copy.noCommits}</div> : null}
    {history.page?.truncated && <div className="diff-history-status">{copy.commitLimit}</div>}
    {history.page?.nextOffset != null && !history.page.pending && !history.page.failed && <button className="diff-load-commits" type="button"
      onClick={() => void history.load(history.page!.nextOffset!)}>{copy.loadCommits}</button>}
  </div>
}

export function DiffNavigation({ history, fileCount, children }: { history?: DiffCommitHistory; fileCount?: number; children: ReactNode }) {
  const id = useId()
  if (!history) return <aside className="diff-navigation">{children}</aside>
  return <aside className="diff-navigation">
    <div className="diff-navigation-tabs" role="tablist" aria-label={copy.navigation}>
      {(['files', 'commits'] as const).map(tab => <button type="button" role="tab" key={tab} id={`${id}-${tab}`}
        tabIndex={history.tab === tab ? 0 : -1} aria-selected={history.tab === tab} aria-controls={`${id}-content`}
        onClick={() => history.setTab(tab)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'files' : event.key === 'End' ? 'commits' : tab === 'files' ? 'commits' : 'files'
          history.setTab(next)
          document.getElementById(`${id}-${next}`)?.focus()
        }}>{copy[tab]}{tab === 'files' && fileCount != null && <span>{fileCount}</span>}</button>)}
    </div>
    {history.selected && <button className="diff-all-changes" type="button" onClick={() => void history.select(null)}>{copy.allChanges}</button>}
    <div className="diff-navigation-content" role="tabpanel" id={`${id}-content`} aria-labelledby={`${id}-${history.tab}`}>
      {history.tab === 'files' ? children : <Commits history={history} />}
    </div>
  </aside>
}
