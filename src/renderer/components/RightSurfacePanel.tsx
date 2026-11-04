import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  RIGHT_SURFACE_DEFINITIONS, rightSurfaceTabKey, type RightSurfaceKind, type RightSurfaceTab
} from '../right-surface'
import { Icon } from './primitives/Icon'
import { usePresence } from '../hooks/usePresence'
import { RightSurfaceTabStrip, rightSurfacePanelId } from './RightSurfaceTabStrip'

export type RightSurfaceContents = Readonly<Partial<Record<RightSurfaceKind, ReactNode>>>

/** One open side-chat instance as the tab strip shows it. */
export interface SideChatTabView {
  conversationId: string
  /** Full title; the strip truncates it visually and keeps this accessible. */
  title: string
  /** Text status such as `需处理`; absent means nothing needs the user. */
  status?: string
}

/** The approved creation entry shown on top of the chooser and in the `+` menu. */
export interface SideChatEntry {
  label: string
  description: string
  /** Why creation is unavailable right now, shown instead of the description. */
  unavailableReason?: string
  /** Read a snapshot and create the child; a bare click never sends a prompt. */
  onSelect: () => void
  historyLabel: string
  onOpenHistory: () => void
  /** Creation status announced politely; `creating` blocks a second identical attempt. */
  notice?: string
  creating?: boolean
}

export interface RightSurfacePanelProps {
  openIds: readonly RightSurfaceKind[]
  activeId: RightSurfaceKind | null
  contents: RightSurfaceContents
  unavailable?: Readonly<Partial<Record<RightSurfaceKind, string>>>
  retainTerminal?: boolean
  workbenchPicker?: ReactNode
  maximized: boolean
  onOpen: (kind: RightSurfaceKind) => void
  onActivate: (kind: RightSurfaceKind) => void
  onClose: (kind: RightSurfaceKind) => void
  onHide: () => void
  onToggleMaximized: () => void
  sideChats?: readonly string[]
  activeSideChatId?: string | null
  sideChatTabs?: readonly SideChatTabView[]
  sideChatEntry?: SideChatEntry
  /** Only the active child of a visible panel is mounted; hidden children keep running in main. */
  renderSideChat?: (conversationId: string) => ReactNode
  onActivateSideChat?: (conversationId: string) => void
  onCloseSideChat?: (conversationId: string) => void
  /** Honest status when the local layout could not be saved; absent means saved. */
  layoutNotice?: string
  /**
   * Whether this panel is really on screen. Ownership of a mounted child body follows the
   * visible panel, not just the selected tab: a hidden workbench must not keep a scoped
   * child subscription alive, and the child's run belongs to main either way.
   */
  visible?: boolean
  className?: string
}

export function RightSurfacePanel({
  openIds, activeId, contents, unavailable, retainTerminal = false, workbenchPicker, maximized, layoutNotice,
  onOpen, onActivate, onClose, onHide, onToggleMaximized,
  sideChats = [], activeSideChatId = null, sideChatTabs = [], sideChatEntry, renderSideChat,
  onActivateSideChat, onCloseSideChat, visible = true, className
}: RightSurfacePanelProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootId = useId().replaceAll(':', '')
  const menuId = `${rootId}-surface-menu`
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const menuInitialFocusRef = useRef<'first' | 'last'>('first')
  const restoreMenuFocusRef = useRef(false)
  const menuPresence = usePresence({
    onClose: () => setMenuOpen(false),
    exitMs: 100,
    onExitStart: () => {
      if (restoreMenuFocusRef.current) addButtonRef.current?.focus()
      restoreMenuFocusRef.current = false
    }
  })
  const tabs: RightSurfaceTab[] = [
    ...openIds.map((kind): RightSurfaceTab => ({ type: 'tool', kind })),
    ...sideChats.map((conversationId): RightSurfaceTab => ({ type: 'side-chat', conversationId }))
  ]
  const activeKey = activeSideChatId ? `side-chat:${activeSideChatId}` : activeId && openIds.includes(activeId) ? activeId : null
  const titles = new Map(sideChatTabs.map((tab) => [tab.conversationId, tab.title]))
  const statuses = new Map(sideChatTabs.flatMap((tab) => tab.status ? [[tab.conversationId, tab.status] as const] : []))
  const mountedKinds: readonly RightSurfaceKind[] = retainTerminal && !openIds.includes('terminal')
    ? [...openIds, 'terminal'] : openIds
  const chooser = openIds.length < 1 && sideChats.length < 1

  const closeMenu = (restoreFocus: boolean): void => {
    restoreMenuFocusRef.current = restoreFocus
    menuPresence.requestClose('pointer')
  }

  useEffect(() => {
    if (!menuOpen || menuPresence.state === 'exit') return
    const initialIndex = menuInitialFocusRef.current === 'last' ? RIGHT_SURFACE_DEFINITIONS.length - 1 : 0
    menuItemRefs.current[initialIndex]?.focus()

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (!menuRef.current?.contains(target) && !addButtonRef.current?.contains(target)) closeMenu(false)
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
  }, [menuOpen, menuPresence.state, menuPresence.requestClose])

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
      closeMenu(false)
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
        {workbenchPicker}
        <RightSurfaceTabStrip
          tabs={tabs}
          activeKey={activeKey}
          sideChatTitles={titles}
          sideChatStatus={statuses}
          fallbackFocusRef={addButtonRef}
          onActivate={(tab) => {
            if (tab.type === 'tool') onActivate(tab.kind)
            else onActivateSideChat?.(tab.conversationId)
          }}
          onClose={(tab) => {
            if (tab.type === 'tool') onClose(tab.kind)
            else onCloseSideChat?.(tab.conversationId)
          }}
        />
        {layoutNotice && <p className="surface-layout-notice" role="status" data-layout-unsaved>{layoutNotice}</p>}

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
              onClick={() => {
                if (menuOpen) { closeMenu(true); return }
                menuInitialFocusRef.current = 'first'
                menuPresence.reset()
                setMenuOpen(true)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                menuInitialFocusRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
                menuPresence.reset()
                setMenuOpen(true)
              }}
            >
              <Icon name="plus" />
            </button>
            {menuOpen && (
              <div
                ref={(node) => { menuRef.current = node; menuPresence.ref(node) }}
                id={menuId}
                className="surface-menu"
                data-state={menuPresence.state}
                role="menu"
                aria-label="可用的 Surface"
                onKeyDown={onMenuKeyDown}
              >
                {sideChatEntry && (
                  <>
                    <button
                      ref={(node) => { menuItemRefs.current[0] = node }}
                      className="menu-item"
                      type="button"
                      role="menuitem"
                      title={sideChatEntry.unavailableReason}
                      disabled={sideChatEntry.creating || Boolean(sideChatEntry.unavailableReason)}
                      onClick={() => { sideChatEntry.onSelect(); closeMenu(true) }}
                    >
                      <Icon name="message" />
                      <span>{sideChatEntry.label}</span>
                      {sideChatEntry.unavailableReason ? <small>不可用</small> : null}
                    </button>
                    <button
                      ref={(node) => { menuItemRefs.current[1] = node }}
                      className="menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => { sideChatEntry.onOpenHistory(); closeMenu(true) }}
                    >
                      <Icon name="clock" />
                      <span>{sideChatEntry.historyLabel}</span>
                    </button>
                  </>
                )}
                {RIGHT_SURFACE_DEFINITIONS.map((definition, index) => {
                  const isOpen = openIds.includes(definition.kind)
                  return (
                    <button
                      ref={(node) => { menuItemRefs.current[sideChatEntry ? index + 2 : index] = node }}
                      className="menu-item"
                      type="button"
                      role="menuitem"
                      key={definition.kind}
                      aria-current={activeId === definition.kind && !activeSideChatId ? 'page' : undefined}
                      title={unavailable?.[definition.kind]}
                      onClick={() => {
                        onOpen(definition.kind)
                        closeMenu(true)
                      }}
                    >
                      <Icon name={definition.icon} />
                      <span>{definition.label}</span>
                      {unavailable?.[definition.kind] ? <small>不可用</small> : isOpen && <small>已打开</small>}
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
        {chooser ? (
          <div className="empty-surface">
            <div className="empty-inner">
              <div className="empty-heading">
                <h2>打开一个 Surface</h2>
                <p>选择要在右侧工作区中显示的内容。</p>
              </div>
              <div className="surface-card-grid" data-surface-chooser>
                {sideChatEntry && (
                  <button
                    className="surface-card surface-card-wide"
                    type="button"
                    data-side-chat-entry
                    title={sideChatEntry.unavailableReason ?? sideChatEntry.description}
                    disabled={sideChatEntry.creating || Boolean(sideChatEntry.unavailableReason)}
                    onClick={sideChatEntry.onSelect}
                  >
                    <span className="card-icon"><Icon name="message" /></span>
                    <strong>{sideChatEntry.label}</strong>
                    <p>{sideChatEntry.unavailableReason ?? sideChatEntry.description}</p>
                  </button>
                )}
                {RIGHT_SURFACE_DEFINITIONS.map((definition) => (
                  <button
                    className="surface-card"
                    type="button"
                    key={definition.kind}
                    onClick={() => onOpen(definition.kind)}
                  >
                    <span className="card-icon"><Icon name={definition.icon} /></span>
                    <strong>{definition.label}</strong>
                    <p>{unavailable?.[definition.kind] ?? definition.description}</p>
                  </button>
                ))}
              </div>
              {sideChatEntry && (
                <div className="surface-chooser-footer">
                  {sideChatEntry.notice && <p className="surface-chooser-notice" role="status" data-side-chat-creation-notice>{sideChatEntry.notice}</p>}
                  <button type="button" className="btn" onClick={sideChatEntry.onOpenHistory}>{sideChatEntry.historyLabel}</button>
                </div>
              )}
            </div>
          </div>
        ) : null}
        {mountedKinds.map((kind) => {
          const key = kind
          return (
            <section
              id={rightSurfacePanelId(rootId, key)}
              className={`surface-content surface-content-${kind}`}
              role="tabpanel"
              aria-labelledby={`${rootId}-${key}-tab`}
              tabIndex={0}
              hidden={activeKey !== key || !openIds.includes(kind)}
              key={kind}
            >
              {activeKey === key || kind === 'terminal' || kind === 'files' ? contents[kind] : null}
            </section>
          )
        })}
        {sideChats.map((conversationId) => (
          <section
            id={rightSurfacePanelId(rootId, `side-chat:${conversationId}`)}
            className="surface-content surface-content-side-chat"
            role="tabpanel"
            aria-labelledby={`${rootId}-side-chat:${conversationId}-tab`}
            tabIndex={0}
            data-side-chat-panel={conversationId}
            hidden={activeKey !== `side-chat:${conversationId}`}
            key={conversationId}
          >
            {/* Only the active child of a visible panel is mounted: an inactive or hidden
                view is not rerun, and its run keeps living in main. */}
            {visible && activeKey === `side-chat:${conversationId}` && renderSideChat ? renderSideChat(conversationId) : null}
          </section>
        ))}
      </div>
    </aside>
  )
}

export { rightSurfaceTabKey }
