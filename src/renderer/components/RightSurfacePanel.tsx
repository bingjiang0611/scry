import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  RIGHT_SURFACE_DEFINITIONS, rightSurfaceTabKey, type RightSurfaceKind, type RightSurfaceTab
} from '../right-surface'
import { Icon } from './primitives/Icon'
import { Menu, MenuItem } from './primitives/Menu'
import { usePresence } from '../hooks/usePresence'
import { MOTION } from '../motion'
import { RightSurfaceTabStrip, rightSurfacePanelId } from './RightSurfaceTabStrip'
import { Button } from './primitives/Button'
import { IconButton } from './primitives/IconButton'
import { Notice } from './primitives/Notice'

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
    exitMs: MOTION.durationExitSm,
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

  // Item movement, Home/End and typeahead come from the Menu primitive; Tab leaves the menu.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') closeMenu(false)
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
        {layoutNotice && <Notice tone="warn" layout="strip" className="surface-layout-notice" role="status" data-layout-unsaved>{layoutNotice}</Notice>}

        <div className="surface-actions">
          <div className="surface-add-wrap">
            <IconButton label="添加 Surface" active={menuOpen}
              ref={addButtonRef}
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
            </IconButton>
            {menuOpen && (
              <Menu
                ref={(node) => { menuRef.current = node; menuPresence.ref(node) }}
                id={menuId}
                className="surface-menu"
                data-state={menuPresence.state}
                label="可用的 Surface"
                onKeyDown={onMenuKeyDown}
              >
                {sideChatEntry && (
                  <>
                    <MenuItem
                      ref={(node) => { menuItemRefs.current[0] = node }}
                      className="menu-item"
                      icon={<Icon name="message" />}
                      title={sideChatEntry.unavailableReason}
                      disabled={sideChatEntry.creating || Boolean(sideChatEntry.unavailableReason)}
                      trailing={sideChatEntry.unavailableReason ? '不可用' : undefined}
                      onClick={() => { sideChatEntry.onSelect(); closeMenu(true) }}
                    >
                      <span>{sideChatEntry.label}</span>
                    </MenuItem>
                    <MenuItem
                      ref={(node) => { menuItemRefs.current[1] = node }}
                      className="menu-item"
                      icon={<Icon name="clock" />}
                      onClick={() => { sideChatEntry.onOpenHistory(); closeMenu(true) }}
                    >
                      <span>{sideChatEntry.historyLabel}</span>
                    </MenuItem>
                  </>
                )}
                {RIGHT_SURFACE_DEFINITIONS.map((definition, index) => {
                  const isOpen = openIds.includes(definition.kind)
                  return (
                    <MenuItem
                      ref={(node) => { menuItemRefs.current[sideChatEntry ? index + 2 : index] = node }}
                      className="menu-item"
                      key={definition.kind}
                      icon={<Icon name={definition.icon} />}
                      aria-current={activeId === definition.kind && !activeSideChatId ? 'page' : undefined}
                      title={unavailable?.[definition.kind]}
                      trailing={unavailable?.[definition.kind] ? '不可用' : isOpen ? '已打开' : undefined}
                      onClick={() => {
                        onOpen(definition.kind)
                        closeMenu(true)
                      }}
                    >
                      <span>{definition.label}</span>
                    </MenuItem>
                  )
                })}
              </Menu>
            )}
          </div>
          <IconButton label={maximized ? '恢复右侧工作区' : '最大化右侧工作区'} active={maximized}
            aria-pressed={maximized}
            title={maximized ? '恢复面板' : '最大化面板'}
            onClick={onToggleMaximized}
          >
            <Icon name={maximized ? 'collapse' : 'expand'} />
          </IconButton>
          <IconButton label="隐藏右侧工作区"
            title="隐藏右侧工作区"
            onClick={onHide}
          >
            <Icon name="panel" />
          </IconButton>
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
                  <Button onClick={sideChatEntry.onOpenHistory}>{sideChatEntry.historyLabel}</Button>
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
