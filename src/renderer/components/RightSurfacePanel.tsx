import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  RIGHT_SURFACE_BY_KIND,
  RIGHT_SURFACE_DEFINITIONS,
  type RightSurfaceKind
} from '../right-surface'
import { Icon } from './primitives/Icon'

export type RightSurfaceContents = Readonly<Partial<Record<RightSurfaceKind, ReactNode>>>

export interface RightSurfacePanelProps {
  openIds: readonly RightSurfaceKind[]
  activeId: RightSurfaceKind | null
  contents: RightSurfaceContents
  maximized: boolean
  onOpen: (kind: RightSurfaceKind) => void
  onActivate: (kind: RightSurfaceKind) => void
  onClose: (kind: RightSurfaceKind) => void
  onHide: () => void
  onToggleMaximized: () => void
  className?: string
}

function nextTabKind(
  openKinds: readonly RightSurfaceKind[],
  currentKind: RightSurfaceKind,
  direction: -1 | 1
): RightSurfaceKind {
  const currentIndex = openKinds.indexOf(currentKind)
  const nextIndex = (currentIndex + direction + openKinds.length) % openKinds.length
  return openKinds[nextIndex] ?? currentKind
}

export function RightSurfacePanel({
  openIds,
  activeId,
  contents,
  maximized,
  onOpen,
  onActivate,
  onClose,
  onHide,
  onToggleMaximized,
  className
}: RightSurfacePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootId = useId().replaceAll(':', '')
  const menuId = `${rootId}-surface-menu`
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuInitialFocusRef = useRef<'first' | 'last'>('first')
  const tabRefs = useRef<Partial<Record<RightSurfaceKind, HTMLButtonElement | null>>>({})
  const pendingCloseFocusRef = useRef<{
    closingKind: RightSurfaceKind
    targetKind: RightSurfaceKind | null
  } | null>(null)
  const activeKind = activeId && openIds.includes(activeId) ? activeId : openIds[0] ?? null

  const closeMenu = (restoreFocus: boolean): void => {
    setMenuOpen(false)
    if (restoreFocus) addButtonRef.current?.focus()
  }

  useEffect(() => {
    if (!menuOpen) return
    const initialIndex = menuInitialFocusRef.current === 'last' ? RIGHT_SURFACE_DEFINITIONS.length - 1 : 0
    menuItemRefs.current[initialIndex]?.focus()

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!menuRef.current?.contains(target) && !addButtonRef.current?.contains(target)) {
        setMenuOpen(false)
      }
    }
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    const pending = pendingCloseFocusRef.current
    if (!pending) return
    pendingCloseFocusRef.current = null
    // The parent can reject a close (for example, a dirty-file confirmation).
    // Only move focus after the requested tab actually disappeared.
    if (openIds.includes(pending.closingKind)) return
    if (pending.targetKind && openIds.includes(pending.targetKind)) {
      tabRefs.current[pending.targetKind]?.focus()
      return
    }
    addButtonRef.current?.focus()
  }, [openIds])

  const activateAndFocus = (kind: RightSurfaceKind): void => {
    onActivate(kind)
    tabRefs.current[kind]?.focus()
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, kind: RightSurfaceKind): void => {
    if (openIds.length < 1) return

    let target: RightSurfaceKind | undefined
    if (event.key === 'ArrowLeft') target = nextTabKind(openIds, kind, -1)
    if (event.key === 'ArrowRight') target = nextTabKind(openIds, kind, 1)
    if (event.key === 'Home') target = openIds[0]
    if (event.key === 'End') target = openIds[openIds.length - 1]
    if (!target) return

    event.preventDefault()
    activateAndFocus(target)
  }

  const closeSurface = (kind: RightSurfaceKind): void => {
    const closingIndex = openIds.indexOf(kind)
    const neighbour = openIds[closingIndex + 1] ?? openIds[closingIndex - 1] ?? null
    pendingCloseFocusRef.current = {
      closingKind: kind,
      targetKind: kind === activeKind ? neighbour : activeKind
    }
    onClose(kind)
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => item != null)
    if (items.length < 1) return
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex: number | null = null

    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
    if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = items.length - 1
    if (event.key === 'Tab') {
      setMenuOpen(false)
      return
    }
    if (nextIndex == null) return

    event.preventDefault()
    items[nextIndex]?.focus()
  }

  return (
    <aside
      className={['right-surface-panel', 'right-workspace', maximized ? 'is-maximized' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-label="右侧 Surface 工作区"
      data-maximized={maximized ? 'true' : 'false'}
    >
      <div className="surface-topbar">
        <div className="surface-tabs" role="tablist" aria-label="已打开的 Surface">
          {openIds.map((kind) => {
            const definition = RIGHT_SURFACE_BY_KIND[kind]
            const selected = activeKind === kind
            const tabId = `${rootId}-${kind}-tab`
            const panelId = `${rootId}-${kind}-panel`
            return (
              <div className={`surface-tab${selected ? ' active' : ''}`} role="presentation" key={kind}>
                <button
                  ref={(node) => { tabRefs.current[kind] = node }}
                  id={tabId}
                  className="surface-tab-activate"
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected || (!activeKind && kind === openIds[0]) ? 0 : -1}
                  onClick={() => onActivate(kind)}
                  onKeyDown={(event) => onTabKeyDown(event, kind)}
                >
                  <Icon name={definition.icon} className="surface-icon" />
                  <span className="label">{definition.label}</span>
                </button>
                <button
                  className="surface-tab-close"
                  type="button"
                  aria-label={`关闭 ${definition.label}`}
                  title={`关闭 ${definition.label}`}
                  onClick={() => closeSurface(kind)}
                >
                  <Icon name="x" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="surface-actions">
          <div className="surface-add-wrap">
            <button
              ref={addButtonRef}
              className={`icon-button${menuOpen ? ' on' : ''}`}
              type="button"
              aria-label="添加 Surface"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              title="添加 Surface"
              onClick={() => setMenuOpen((open) => {
                if (!open) menuInitialFocusRef.current = 'first'
                return !open
              })}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                menuInitialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
                setMenuOpen(true)
              }}
            >
              <Icon name="plus" />
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                id={menuId}
                className="surface-menu"
                role="menu"
                aria-label="可用的 Surface"
                onKeyDown={onMenuKeyDown}
              >
                {RIGHT_SURFACE_DEFINITIONS.map((definition, index) => {
                  const isOpen = openIds.includes(definition.kind)
                  return (
                    <button
                      ref={(node) => { menuItemRefs.current[index] = node }}
                      className="menu-item"
                      type="button"
                      role="menuitem"
                      key={definition.kind}
                      aria-current={activeKind === definition.kind ? 'page' : undefined}
                      onClick={() => {
                        onOpen(definition.kind)
                        closeMenu(true)
                      }}
                    >
                      <Icon name={definition.icon} />
                      <span>{definition.label}</span>
                      {isOpen && <small>已打开</small>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <button
            className={`icon-button${maximized ? ' on' : ''}`}
            type="button"
            aria-label={maximized ? '恢复右侧工作区' : '最大化右侧工作区'}
            aria-pressed={maximized}
            title={maximized ? '恢复面板' : '最大化面板'}
            onClick={onToggleMaximized}
          >
            <Icon name={maximized ? 'collapse' : 'expand'} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="隐藏右侧工作区"
            title="隐藏右侧工作区"
            onClick={onHide}
          >
            <Icon name="panel" />
          </button>
        </div>
      </div>

      <div className="surface-body">
        {openIds.length < 1 ? (
          <div className="empty-surface">
            <div className="empty-inner">
              <div className="empty-heading">
                <h2>打开一个 Surface</h2>
                <p>选择要在右侧工作区中显示的内容。</p>
              </div>
              <div className="surface-card-grid">
                {RIGHT_SURFACE_DEFINITIONS.map((definition) => (
                  <button
                    className="surface-card"
                    type="button"
                    key={definition.kind}
                    onClick={() => onOpen(definition.kind)}
                  >
                    <span className="card-icon"><Icon name={definition.icon} /></span>
                    <strong>{definition.label}</strong>
                    <p>{definition.description}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          openIds.map((kind) => {
            return (
              <section
                id={`${rootId}-${kind}-panel`}
                className={`surface-content surface-content-${kind}`}
                role="tabpanel"
                aria-labelledby={`${rootId}-${kind}-tab`}
                tabIndex={0}
                hidden={activeKind !== kind}
                key={kind}
              >
                {contents[kind]}
              </section>
            )
          })
        )}
      </div>
    </aside>
  )
}
