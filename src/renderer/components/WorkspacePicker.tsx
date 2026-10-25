import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceSelectionController } from '../hooks/useWorkspaceSelection'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'
import { workspaceCopy as copy } from '../constants/workspace-copy'
import { Icon } from './primitives/Icon'
import './workspace-picker.css'

const branchLabel = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '')

function WorkspaceChoicesList({ controller }: { controller: WorkspaceSelectionController }) {
  const { choices, selection, validating } = controller
  const intent = selection && !('invalid' in selection) ? selection.intent : undefined
  const rows = !choices ? [] : choices.page.kind === 'branches'
    ? choices.page.items.map(branch => {
      const current = branch.name === `refs/heads/${choices.branch}`
      const selectedRef = intent?.kind === 'newWorktree' ? intent.base.name : intent?.kind === 'current' ? intent.branch?.name : undefined
      const disabled = intent?.kind !== 'newWorktree' && (branch.kind === 'remote' || choices.dirty && !current && !branch.worktreeIds.length)
      return { id: branch.name, label: branchLabel(branch.name), secondary: undefined,
        note: current ? copy.currentBadge : branch.worktreeIds.length ? copy.worktreeBadge : branch.kind === 'remote' ? copy.remoteBadge : undefined,
        title: disabled ? branch.kind === 'remote' ? copy.remoteRefs : copy.dirtySwitch : branchLabel(branch.name),
        selected: selectedRef ? branch.name === selectedRef : current, disabled,
        select: () => { void controller.chooseBranch(branch) } }
    })
    : choices.page.items.filter(tree => !tree.current).map(tree => {
      const disabled = tree.busy || tree.bare || tree.locked !== null || tree.prunable !== null
      return { id: tree.id, label: copy.existingWorktree,
        secondary: tree.branchRef ? branchLabel(tree.branchRef) : tree.path.split('/').at(-1), note: undefined,
        title: disabled ? tree.busy ? copy.occupied : copy.invalidWorktree : tree.path,
        selected: intent?.kind === 'existingWorktree' && tree.id === intent.worktreeId, disabled,
        select: () => { void controller.chooseWorktree(tree) } }
    })
  const id = useId()
  const [active, setActive] = useState(0)
  const rowHeight = choices?.page.kind === 'worktrees' ? 58 : 36
  const virtual = useFixedVirtualRows(rows.length, rowHeight)
  if (!rows.length) return controller.editor.menu === 'workspace' && !controller.editor.query ? null
    : <p className="workspace-picker-note">{copy.empty}</p>
  return <div ref={virtual.ref} className="workspace-choice-list" style={{ maxHeight: 272 }}
    role="menu" tabIndex={0} aria-label={copy.results} data-workspace-navigation
    aria-activedescendant={active >= virtual.start && active < virtual.end ? `${id}-${active}` : undefined}
    onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation()
        if (!rows[active]?.disabled && !validating) rows[active]?.select()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
      let index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : active + step
      while (index >= 0 && index < rows.length && rows[index].disabled) index += step
      if (index < 0 || index >= rows.length) return
      setActive(index)
      virtual.reveal(index)
    }}>
    <div style={{ height: virtual.totalHeight, position: 'relative' }}>
      {rows.slice(virtual.start, virtual.end).map((row, index) => <button key={row.id} type="button"
        role="menuitemradio" id={`${id}-${virtual.start + index}`} tabIndex={-1} aria-checked={row.selected}
        aria-setsize={rows.length} aria-posinset={virtual.start + index + 1} disabled={row.disabled || validating} title={row.title}
        className={`workspace-choice${row.selected ? ' selected' : ''}${virtual.start + index === active ? ' keyboard-active' : ''}`}
        style={{ position: 'absolute', insetInline: 0, top: (virtual.start + index) * rowHeight, height: rowHeight }}
        onClick={row.select}>
        {row.secondary && <Icon name="undo" />}
        <span className="workspace-choice-name"><strong>{row.label}</strong>{row.secondary && <small>{row.secondary}</small>}</span>
        {row.note && <span className="workspace-choice-note">{row.note}</span>}
      </button>)}
    </div>
  </div>
}

function WorkspacePicker({ controller, anchor, id }: {
  controller: WorkspaceSelectionController
  anchor: HTMLButtonElement
  id: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const { editor, choices, loading, validating, error, close, selection } = controller
  const mode = selection && !('invalid' in selection) ? selection.intent.kind : 'current'
  const workspaceMenu = editor.menu === 'workspace'
  const measure = (): CSSProperties => {
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 24)
    return { width, left: Math.max(12, Math.min(workspaceMenu ? rect.left : rect.right - width, window.innerWidth - width - 12)),
      bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(80, rect.top - 18) }
  }
  const [position, setPosition] = useState(measure)
  useEffect(() => {
    const update = (): void => setPosition(measure())
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [anchor])
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [close, anchor])
  useEffect(() => {
    if (workspaceMenu) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    else search.current?.focus()
    return () => {
      if (document.activeElement === document.body || panel.current?.contains(document.activeElement)) anchor.focus()
    }
  }, [anchor, workspaceMenu])
  return createPortal(<div ref={panel} id={id} className="workspace-picker" style={position}
    role="menu" aria-label={workspaceMenu ? copy.mode : copy.search} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && !anchor.contains(event.relatedTarget)) close()
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); anchor.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      if (event.target instanceof HTMLInputElement && (event.key === 'Home' || event.key === 'End')) return
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-workspace-navigation]:not(:disabled)'))
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }}>
    {workspaceMenu && <>
      <div className="workspace-picker-label">{copy.mode}</div>
      <button type="button" className={`workspace-mode-choice${mode === 'current' ? ' selected' : ''}`} data-workspace-navigation
        role="menuitemradio" aria-checked={mode === 'current'} disabled={validating} onClick={controller.reset}>
        <Icon name="folder" /><span>{copy.current}</span>
      </button>
      <button type="button" className={`workspace-mode-choice${mode === 'newWorktree' ? ' selected' : ''}`} data-workspace-navigation
        role="menuitemradio" aria-checked={mode === 'newWorktree'} title={copy.cleanWorktree} disabled={!choices?.head || loading || validating}
        onClick={() => { void controller.chooseNewWorktree() }}>
        <Icon name="branch" /><span>{copy.newWorktree}</span>
      </button>
    </>}
    {(!workspaceMenu || editor.query || (choices?.page.items.length ?? 0) > 6 || editor.cursor || choices?.nextCursor) &&
      <div className="workspace-ref-search">
        <Icon name="search" />
        <input ref={search} type="search" value={editor.query} aria-label={copy.search} placeholder={workspaceMenu ? copy.searchWorktreePlaceholder : copy.searchPlaceholder}
          maxLength={240} disabled={validating} onChange={event => controller.changeEditor({ query: event.target.value, cursor: undefined })} />
      </div>}
    {loading ? <p role="status" className="workspace-picker-note">{copy.loading}</p>
      : <WorkspaceChoicesList key={JSON.stringify([editor.menu, editor.query, editor.cursor])} controller={controller} />}
    {error && <div className="workspace-picker-error" role="alert">{error}
      <button type="button" onClick={controller.refresh} disabled={loading || validating}>{copy.refresh}</button>
    </div>}
    {choices?.limited && <p className="workspace-picker-note">{copy.limited}</p>}
    {(editor.cursor || choices?.nextCursor) && <footer className="workspace-picker-footer">
      {editor.cursor && <button type="button" onClick={controller.firstPage} disabled={loading || validating}>{copy.firstPage}</button>}
      {choices?.nextCursor && <button type="button" onClick={controller.nextPage} disabled={loading || validating}>{copy.next}</button>}
    </footer>}
  </div>, document.body)
}

export function WorkspaceContext({ controller, cwd, onOpenRun }: {
  controller: WorkspaceSelectionController
  cwd: string | null
  onOpenRun: (cwd: string, runId: string) => void
}) {
  const workspaceAnchor = useRef<HTMLButtonElement>(null)
  const refsAnchor = useRef<HTMLButtonElement>(null)
  const id = useId()
  const { selection, metadata, operation, busy, editable } = controller
  const intent = selection && !('invalid' in selection) ? selection.intent : undefined
  const mode = intent?.kind ?? 'current'
  const branch = intent?.kind === 'newWorktree' ? copy.baseRef(branchLabel(intent.base.name))
    : intent?.kind === 'current' && intent.branch ? branchLabel(intent.branch.name)
      : intent?.kind === 'existingWorktree' ? metadata?.selectedWorktree?.branchRef
        ? branchLabel(metadata.selectedWorktree.branchRef) : copy.existingWorktree
        : metadata?.branch ?? (metadata?.head ? copy.detached(metadata.head) : metadata ? copy.unborn : copy.unavailable)
  const target = intent?.kind === 'existingWorktree' ? metadata?.selectedWorktree?.path : cwd
  const anchor = controller.editor.menu === 'workspace' ? workspaceAnchor.current : refsAnchor.current
  const toggle = (menu: 'workspace' | 'refs'): void => {
    if (controller.open && controller.editor.menu === menu) controller.close()
    else controller.show(menu)
  }
  return <div className="workspace-context workspace-composer-context" aria-label={copy.label}>
    <div className="workspace-context-strip">
      <button ref={workspaceAnchor} type="button" data-workspace-menu="workspace" disabled={!controller.canChange || !cwd}
        onClick={() => toggle('workspace')} aria-haspopup="menu" aria-expanded={controller.open && controller.editor.menu === 'workspace'} aria-controls={id}
        title={!editable ? copy.readonly : intent?.kind === 'newWorktree' ? copy.newBranchTarget(intent.newBranch) : target ? copy.target(target) : copy.noProject}
        aria-label={copy.change}>
        <Icon name={editable ? mode === 'current' ? 'folder' : 'branch' : 'lock'} /><span>{copy[mode]}</span>{editable && <Icon name="chevronDown" />}
      </button>
      <button ref={refsAnchor} type="button" data-workspace-menu="refs" disabled={!controller.canChange || !cwd || mode === 'existingWorktree'}
        onClick={() => toggle('refs')} aria-haspopup="menu" aria-expanded={controller.open && controller.editor.menu === 'refs'} aria-controls={id}
        aria-label={copy.branch}>
        <Icon name="branch" /><span>{branch}</span>{editable && mode !== 'existingWorktree' && <Icon name="chevronDown" />}
      </button>
    </div>
    {editable && busy && selection && <p role="status">{copy.preparing}</p>}
    {editable && !busy && controller.blockedReason && controller.blockedReason !== copy.loading && <p role="status">{controller.blockedReason}</p>}
    {editable && !busy && operation?.phase === 'prepared' && <p role="status">{copy.prepared}</p>}
    {editable && selection && !('invalid' in selection) && !busy &&
      (operation || controller.blockedReason && controller.blockedReason !== copy.loading) && <div className="workspace-context-recovery">
      <button type="button" onClick={() => { void controller.inspect() }}>{copy.inspect}</button>
      {operation?.phase === 'registered' && operation.runId && operation.workspace &&
        <button type="button" onClick={() => onOpenRun(operation.workspace!.cwd, operation.runId!)}>{copy.openRun}</button>}
    </div>}
    {controller.open && anchor && <WorkspacePicker key={controller.editor.menu} controller={controller} anchor={anchor} id={id} />}
  </div>
}
