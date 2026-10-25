import { useId } from 'react'
import type { DiffFile } from '@shared/trace'
import { displayDiffPath as displayPath, type DiffScope } from '../turn-diff'
import { DIFF_COPY as detail } from '../constants/diff-copy'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'

export function DiffFiles({ files, selectedPath, select, scope, repoRoot, showTitle = true }: {
  files: DiffFile[]
  selectedPath: string
  select: (path: string) => void
  scope: DiffScope
  repoRoot?: string
  showTitle?: boolean
}) {
  const id = useId()
  const rows = useFixedVirtualRows(files.length, 38)
  const selectedIndex = files.findIndex(file => file.path === selectedPath)
  return (
    <nav className="diff-file-nav" aria-label={detail.fileList(scope)}>
      {showTitle && <div className="diff-file-nav-title"><span>{detail.files}</span><span>{files.length}</span></div>}
      <div ref={rows.ref} className="diff-virtual-files" role="listbox" tabIndex={0} aria-label={detail.fileList(scope)}
        aria-activedescendant={selectedIndex >= rows.start && selectedIndex < rows.end ? `${id}-${selectedIndex}` : undefined}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || files.length === 0) return
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1
            : Math.max(0, Math.min(files.length - 1, selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)))
          select(files[next].path)
          rows.reveal(next)
        }}>
        <div style={{ height: rows.totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: rows.offset, left: 0, right: 0 }}>
            {files.slice(rows.start, rows.end).map((file, index) => (
              <button type="button" role="option" id={`${id}-${rows.start + index}`} tabIndex={-1}
                aria-selected={file.path === selectedPath} aria-posinset={rows.start + index + 1} aria-setsize={files.length}
                className={file.path === selectedPath ? 'active' : ''} onClick={() => select(file.path)}
                title={file.path} key={file.path}>
                <span>{displayPath(file.path, repoRoot)}</span>
                <span className="diff-file-nav-count">
                  {file.binary ? detail.binary : <><b className="add">{detail.added(file.added)}</b><b className="del">{detail.deleted(file.deleted)}</b></>}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
}
