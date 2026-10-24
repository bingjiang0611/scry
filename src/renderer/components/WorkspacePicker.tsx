import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceSelectionController } from '../hooks/useWorkspaceSelection'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'
import { workspaceCopy as copy } from '../constants/workspace-copy'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import './workspace-picker.css'

const branchLabel = (name: string): string => name.replace(/^refs\/(heads|remotes)\//, '')

function WorkspaceChoicesList({ controller }: { controller: WorkspaceSelectionController }) {
  const { choices, editor, changeEditor } = controller
  const id = useId()
  const rows = !choices ? [] : choices.page.kind === 'branches'
    ? choices.page.items.map(branch => {
      const current = branch.name === `refs/heads/${choices.branch}`
      const dirtySwitch = editor.mode === 'current' && choices.dirty && !current && !branch.worktreeIds.length
      return {
        id: branch.name, label: branchLabel(branch.name), detail: branch.head.slice(0, 8),
        note: dirtySwitch ? copy.dirtySwitch : current ? copy.current : branch.kind === 'remote'
          ? copy.cachedRemote : branch.worktreeIds.length ? copy.reused : '',
        disabled: controller.validating || dirtySwitch || editor.mode === 'current' && branch.kind !== 'local',
        selected: editor.branchName === branch.name,
        select: () => changeEditor({ branchName: branch.name })
      }
    })
    : choices.page.items.map(tree => ({
      id: tree.id, label: tree.path, detail: tree.branchRef ? branchLabel(tree.branchRef) : tree.head ? copy.detached(tree.head) : copy.unborn,
      note: tree.busy ? copy.occupied : tree.locked !== null || tree.prunable !== null || tree.bare ? copy.invalidWorktree : '',
      disabled: controller.validating || tree.busy || tree.bare || tree.locked !== null || tree.prunable !== null,
      selected: editor.worktreeId === tree.id,
      select: () => changeEditor({ worktreeId: tree.id })
    }))
  const virtual = useFixedVirtualRows(rows.length, 56)
  const selected = rows.findIndex(row => row.selected)
  return <div ref={virtual.ref} className="workspace-choice-list" role="listbox" tabIndex={0}
    aria-label={copy.results}
    aria-activedescendant={selected >= virtual.start && selected < virtual.end ? `${id}-${selected}` : undefined}
    onKeyDown={event => {
      const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      let index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : selected < 0 ? 0 : selected + step
      while (index >= 0 && index < rows.length && rows[index].disabled) index += step
      if (index < 0 || index >= rows.length) return
      rows[index].select()
      virtual.reveal(index)
    }}>
    {rows.length === 0 ? <p className="workspace-picker-note">{copy.empty}</p> : <div style={{ height: virtual.totalHeight, position: 'relative' }}>
      <div style={{ position: 'absolute', top: virtual.offset, left: 0, right: 0 }}>
        {rows.slice(virtual.start, virtual.end).map((row, offset) => <button type="button" role="option"
          id={`${id}-${virtual.start + offset}`} key={row.id} tabIndex={-1} aria-selected={row.selected}
          aria-posinset={virtual.start + offset + 1} aria-setsize={rows.length} disabled={row.disabled}
          className="workspace-choice" title={copy.resultLabel(row.label, row.note)}
          onClick={() => { row.select(); virtual.reveal(virtual.start + offset) }}>
          <span><strong>{row.label}</strong><small>{copy.resultLabel(row.detail, row.note)}</small></span>
          {row.selected && <Icon name="check" />}
        </button>)}
      </div>
    </div>}
  </div>
}

export function WorkspacePicker({ controller, anchor }: { controller: WorkspaceSelectionController; anchor: HTMLDivElement }) {
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const { editor, changeEditor, choices, loading, validating, error, close } = controller
  const measure = (): CSSProperties => {
    const rect = (anchor.closest('.composer')?.querySelector('.send') ?? anchor).getBoundingClientRect()
    const width = Math.min(600, window.innerWidth - 32)
    return { left: Math.max(16, Math.min(anchor.getBoundingClientRect().left, window.innerWidth - width - 16)),
      bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(80, rect.top - 24) }
  }
  const [position, setPosition] = useState(measure)
  useEffect(() => {
    const update = (): void => setPosition(measure())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [anchor])
  const style = { '--workspace-left': `${position.left}px`, '--workspace-bottom': `${position.bottom}px`,
    '--workspace-height': `${position.maxHeight}px` } as CSSProperties
  return createPortal(<div className="workspace-picker-layer" style={style} onKeyDownCapture={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }}>
    <ModalFrame labelledBy={titleId} initialFocusRef={searchRef} className="workspace-picker" onClose={close}>
      <header className="workspace-picker-heading"><h2 id={titleId}>{copy.title}</h2>
        <button type="button" aria-label={copy.close} onClick={close}><Icon name="x" /></button>
      </header>
      <p className="workspace-picker-note">{copy.deferred}</p>
      <fieldset className="workspace-mode"><legend>{copy.mode}</legend>
        {(['current', 'newWorktree', 'existingWorktree'] as const).map(mode => <label key={mode}>
          <input type="radio" name={titleId} value={mode} checked={editor.mode === mode} disabled={validating || mode === 'newWorktree' && !controller.metadata?.head}
            onChange={() => changeEditor({ mode, query: '', cursor: undefined, branchName: '', worktreeId: '' })} />
          <span>{copy[mode]}</span>
        </label>)}
      </fieldset>
      <div className="workspace-search">
        <input ref={searchRef} type="search" value={editor.query} aria-label={copy.search} placeholder={copy.searchPlaceholder}
          maxLength={240} disabled={validating} onChange={event => changeEditor({ query: event.target.value, cursor: undefined })} />
        <button type="button" disabled={loading || validating} onClick={controller.refresh}>{copy.refresh}</button>
      </div>
      {editor.mode === 'newWorktree' && <label className="workspace-new-branch">{copy.newBranch}
        <input value={editor.newBranch} placeholder={copy.newBranchPlaceholder} maxLength={240} disabled={validating}
          onChange={event => changeEditor({ newBranch: event.target.value })} />
      </label>}
      {choices && <div className="workspace-picker-meta">
        <span title={choices.root}>{choices.root}</span><span>{copy.observed(choices.observedAt)}</span>
        {choices.dirty && <span>{copy.dirty}</span>}{choices.commonDirBusy && <span>{copy.occupied}</span>}
      </div>}
      {loading ? <p role="status" className="workspace-picker-note">{copy.loading}</p>
        : <WorkspaceChoicesList key={JSON.stringify([editor.mode, editor.query, editor.cursor])} controller={controller} />}
      {error && <p role="alert" className="workspace-picker-error">{error}</p>}
      {choices?.limited && <p className="workspace-picker-note">{copy.limited}</p>}
      {editor.mode === 'newWorktree' && <p className="workspace-picker-note">{copy.remoteRefs} {copy.cleanWorktree}</p>}
      <footer className="workspace-picker-footer">
        <button type="button" onClick={controller.firstPage} disabled={!editor.cursor || loading || validating}>{copy.firstPage}</button>
        <button type="button" onClick={controller.nextPage} disabled={!choices?.nextCursor || loading || validating}>{copy.next}</button>
        <span />
        <button type="button" onClick={controller.reset} disabled={!controller.canChange || validating}>{copy.current}</button>
        <button type="button" className="workspace-apply" disabled={!choices || loading || validating || !controller.canChange}
          onClick={() => { void controller.apply() }}>{validating ? copy.validating : copy.apply}</button>
      </footer>
    </ModalFrame>
  </div>, document.body)
}

export function WorkspaceContext({ controller, cwd, onOpenRun }: {
  controller: WorkspaceSelectionController
  cwd: string | null
  onOpenRun: (cwd: string, runId: string) => void
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const { selection, metadata, operation, busy, editable } = controller
  const intent = selection && !('invalid' in selection) ? selection.intent : undefined
  const mode = intent?.kind ?? 'current'
  const branch = intent?.kind === 'newWorktree' ? copy.baseRef(branchLabel(intent.base.name))
    : intent?.kind === 'current' && intent.branch ? branchLabel(intent.branch.name)
      : intent?.kind === 'existingWorktree' ? metadata?.selectedWorktree?.branchRef
        ? branchLabel(metadata.selectedWorktree.branchRef) : copy.existingWorktree
        : metadata?.branch ?? (metadata?.head ? copy.detached(metadata.head) : metadata ? copy.unborn : copy.unavailable)
  const target = intent?.kind === 'existingWorktree' ? metadata?.selectedWorktree?.path : cwd
  return <div ref={anchor} className="workspace-context" aria-label={copy.label}>
    <div className="workspace-context-strip">
      <button type="button" disabled={!controller.canChange || !cwd} onClick={controller.show}
        title={!editable ? copy.readonly : target ? copy.target(target) : copy.noProject} aria-label={copy.change}>
        <Icon name={editable ? 'folder' : 'lock'} /><span>{copy[mode]}</span>{editable && <Icon name="chevronDown" />}
      </button>
      <button type="button" disabled={!controller.canChange || !cwd || mode === 'existingWorktree'} onClick={controller.show}
        aria-label={copy.branch} title={metadata ? copy.observed(metadata.observedAt) : copy.unavailable}>
        <Icon name="branch" /><span>{branch}</span>
      </button>
    </div>
    {editable && intent?.kind === 'current' && intent.branch && !busy && <p>{copy.pendingSwitch}</p>}
    {editable && intent?.kind === 'newWorktree' && <p>{copy.newBranchTarget(intent.newBranch)} {cwd && copy.sourceStats(cwd)}</p>}
    {editable && busy && selection && <p role="status">{copy.preparing}</p>}
    {editable && !busy && controller.blockedReason && <p role="status">{controller.blockedReason}</p>}
    {editable && !busy && operation?.phase === 'prepared' && <p role="status">{copy.prepared}</p>}
    {editable && selection && !('invalid' in selection) && !busy && <div className="workspace-context-recovery">
      <button type="button" onClick={() => { void controller.inspect() }}>{copy.inspect}</button>
      {operation?.phase === 'registered' && operation.runId && operation.workspace &&
        <button type="button" onClick={() => onOpenRun(operation.workspace!.cwd, operation.runId!)}>{copy.openRun}</button>}
    </div>}
    {controller.open && anchor.current && <WorkspacePicker controller={controller} anchor={anchor.current} />}
  </div>
}
