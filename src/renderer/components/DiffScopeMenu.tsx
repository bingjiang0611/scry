import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { useDiffInspector } from '../hooks/useDiffInspector'
import { useFixedVirtualRows } from '../hooks/useFixedVirtualRows'
import { DIFF_COPY as copy } from '../constants/diff-copy'
import { Icon } from './primitives/Icon'
import './diff-scope-menu.css'

type InspectorState = ReturnType<typeof useDiffInspector>
export interface DiffHistoryNavigation {
  hasOlder: boolean
  loading: boolean
  load: () => void
}

function TurnChoices({ state, history, choose }: {
  state: InspectorState
  history?: DiffHistoryNavigation
  choose: (runId: string) => void
}) {
  const id = useId()
  const turns = useMemo(() => [...state.turnOptions].reverse(), [state.turnOptions])
  const [activeRunId, setActiveRunId] = useState(state.selectedRunId)
  const active = Math.max(0, turns.findIndex(turn => turn.runId === activeRunId))
  const virtual = useFixedVirtualRows(turns.length, 48)
  useEffect(() => { virtual.reveal(active) }, [])
  return <>
    <div className="diff-menu-caption">{copy.loadedTurns}</div>
    {turns.length ? <div ref={virtual.ref} className="diff-turn-list" role="menu" tabIndex={0} aria-label={copy.turnPicker}
      aria-activedescendant={active >= virtual.start && active < virtual.end ? `${id}-${active}` : undefined}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation()
          if (turns[active]) choose(turns[active].runId)
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? turns.length - 1
          : Math.max(0, Math.min(turns.length - 1, active + (event.key === 'ArrowUp' ? -1 : 1)))
        setActiveRunId(turns[next].runId)
        virtual.reveal(next)
      }}>
      <div style={{ height: virtual.totalHeight, position: 'relative' }}>
        {turns.slice(virtual.start, virtual.end).map((turn, index) => <button type="button" key={turn.runId}
          id={`${id}-${virtual.start + index}`} data-run-id={turn.runId} role="menuitemradio" tabIndex={-1}
          aria-checked={state.scope === 'turn' && turn.runId === state.selectedRunId}
          aria-posinset={virtual.start + index + 1} aria-setsize={turns.length}
          className={`diff-turn-choice${virtual.start + index === active ? ' keyboard-active' : ''}`}
          style={{ position: 'absolute', top: (virtual.start + index) * 48, insetInline: 0, height: 48 }}
          onClick={() => choose(turn.runId)}>
          <span>{copy.turnOption(turn.index, '')}</span><small>{turn.prompt.slice(0, 80) || copy.missingPrompt}</small>
        </button>)}
      </div>
    </div> : <p className="diff-menu-caption">{copy.noTurns}</p>}
    {history?.hasOlder && <button type="button" className="diff-load-turns" disabled={history.loading} onClick={history.load}>
      {history.loading ? copy.loadingTurns : copy.loadOlderTurns}
    </button>}
  </>
}

export function DiffScopeMenu({ state, history }: { state: InspectorState; history?: DiffHistoryNavigation }) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const submenu = useRef<HTMLDivElement>(null)
  const turnTrigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [turnsOpen, setTurnsOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const [turnPosition, setTurnPosition] = useState<CSSProperties>({})
  const selected = state.turnOptions.find(turn => turn.runId === state.selectedRunId)
  const label = state.scope === 'workspace' ? copy.uncommitted : state.scope === 'branch' ? copy.changes
    : state.latestTurn ? copy.latestTurn : selected ? copy.turnOption(selected.index, '') : copy.scopes.turn
  const close = (restore = true): void => {
    setOpen(false); setTurnsOpen(false)
    if (restore) anchor.current?.focus()
  }
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const rect = anchor.current!.getBoundingClientRect()
      const width = Math.min(240, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      const top = rect.bottom + 6
      setPosition({ left, top, width, maxHeight: window.innerHeight - top - 12 })
      if (turnsOpen) {
        const subWidth = Math.min(280, window.innerWidth - 24)
        const right = left + width + 4
        const subLeft = right + subWidth <= window.innerWidth - 12 ? right
          : left - subWidth - 4 >= 12 ? left - subWidth - 4 : left
        const subTop = Math.max(12, Math.min(turnTrigger.current!.getBoundingClientRect().top, window.innerHeight - 380))
        setTurnPosition({ left: subLeft, top: subTop, width: subWidth, maxHeight: window.innerHeight - subTop - 12 })
      }
    }
    measure()
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !submenu.current?.contains(event.target) && !anchor.current?.contains(event.target)) close(false)
    }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', measure)
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', measure) }
  }, [open, turnsOpen])
  useEffect(() => {
    if (open && !turnsOpen) root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus()
  }, [open])
  const chooseScope = (scope: InspectorState['scope']): void => { state.selectScope(scope); close() }
  return <>
    <button ref={anchor} type="button" className="diff-scope-trigger" aria-label={copy.scopeLabel}
      aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => open ? close() : setOpen(true)}>
      <span>{label}</span><Icon name="chevronDown" />
    </button>
    {open && createPortal(<div className="diff-menu-layer" onBlur={event => {
      const target = event.relatedTarget
      if (target instanceof Node && !event.currentTarget.contains(target) && !anchor.current?.contains(target)) close(false)
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'ArrowLeft' && turnsOpen) {
        event.preventDefault(); setTurnsOpen(false); turnTrigger.current?.focus(); return
      }
      if (event.key === 'ArrowRight' && document.activeElement === turnTrigger.current) {
        event.preventDefault(); setTurnsOpen(true); return
      }
      if (!root.current?.contains(event.target as Node) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = Array.from(root.current.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      event.preventDefault(); items[next]?.focus()
    }}>
      <div ref={root} id={id} className="diff-scope-menu" style={position} role="menu" aria-label={copy.changes}>
        <button type="button" role="menuitemradio" aria-checked={state.scope === 'branch'} data-diff-choice="branch" onClick={() => chooseScope('branch')}>{copy.changes}</button>
        <button type="button" role="menuitemradio" aria-checked={state.scope === 'workspace'} data-diff-choice="workspace" onClick={() => chooseScope('workspace')}>{copy.uncommitted}</button>
        <button type="button" role="menuitemradio" aria-checked={state.latestTurn} data-diff-choice="latest" onClick={() => chooseScope('turn')}>{copy.latestTurn}</button>
        <button ref={turnTrigger} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={turnsOpen}
          aria-controls={`${id}-turns`} data-diff-choice="turns" onClick={() => setTurnsOpen(!turnsOpen)}>
          <span>{copy.turns}</span><Icon name="chevronRight" />
        </button>
      </div>
      {turnsOpen && <div ref={submenu} id={`${id}-turns`} className="diff-turn-menu" style={turnPosition} role="menu" aria-label={copy.turnPicker}>
        <button type="button" className="diff-turn-back" aria-label={copy.backToScopes} onClick={() => { setTurnsOpen(false); turnTrigger.current?.focus() }}>
          <Icon name="chevronRight" /><span>{copy.turns}</span>
        </button>
        <TurnChoices state={state} history={history} choose={runId => { state.selectTurn(runId); close() }} />
      </div>}
    </div>, document.body)}
  </>
}
