import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { RIGHT_SURFACE_DEFINITIONS, rightSurfaceTabKey, type RightSurfaceDefinition, type RightSurfaceTab } from '../right-surface'
import { Icon } from './primitives/Icon'
import { useTabIndicator } from '../hooks/useTabIndicator'

export interface RightSurfaceTabStripProps {
  /** Flat tab order: tool tabs first, then side-chat instances. */
  tabs: readonly RightSurfaceTab[]
  activeKey: string | null
  /** Full title of each open child; the tab label is truncated visually, not in the DOM. */
  sideChatTitles: ReadonlyMap<string, string>
  /** Status of one child, announced instead of colour alone. */
  sideChatStatus?: ReadonlyMap<string, string>
  onActivate: (tab: RightSurfaceTab) => void
  onClose: (tab: RightSurfaceTab) => void
  /** Focus target when the last tab closed: the add button of the owning panel. */
  fallbackFocusRef: { current: HTMLElement | null }
}

function tabLabel(tab: RightSurfaceTab, titles: ReadonlyMap<string, string>): string {
  if (tab.type === 'tool') return RIGHT_SURFACE_DEFINITIONS.find((item) => item.kind === tab.kind)!.label
  return titles.get(tab.conversationId) ?? ''
}

function toolIcon(tab: RightSurfaceTab): RightSurfaceDefinition['icon'] | 'message' {
  if (tab.type === 'side-chat') return 'message'
  return RIGHT_SURFACE_DEFINITIONS.find((item) => item.kind === tab.kind)!.icon
}

/**
 * One flat, keyboard-navigable tab strip for tools and side-chat instances.
 *
 * Arrow keys, Home and End move across the whole flat order, so a child tab is reachable
 * exactly like a tool tab. Closing only removes this view: the panel reports the close
 * to the owner and moves focus to the neighbouring tab once it actually disappeared.
 */
export function RightSurfaceTabStrip({
  tabs, activeKey, sideChatTitles, sideChatStatus, onActivate, onClose, fallbackFocusRef
}: RightSurfaceTabStripProps) {
  const rootId = useId().replaceAll(':', '')
  const listRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const itemRefs = useRef(new Map<string, HTMLElement | null>())
  const pendingCloseFocusRef = useRef<{ closingKey: string; targetKey: string | null } | null>(null)
  const keys = tabs.map(rightSurfaceTabKey)
  const { indicatorRef } = useTabIndicator(listRef, activeKey, itemRefs.current, keys)

  useEffect(() => {
    const pending = pendingCloseFocusRef.current
    if (!pending) return
    pendingCloseFocusRef.current = null
    // The owner can refuse a close (dirty-file confirmation), so only move focus after
    // the requested tab really left the strip.
    if (keys.includes(pending.closingKey)) return
    const target = pending.targetKey && keys.includes(pending.targetKey) ? buttonRefs.current.get(pending.targetKey) : null
    if (target) target.focus()
    else fallbackFocusRef.current?.focus()
  }, [keys, fallbackFocusRef])

  const move = (event: KeyboardEvent<HTMLButtonElement>, key: string): void => {
    if (keys.length < 1) return
    const index = keys.indexOf(key)
    let target: string | undefined
    if (event.key === 'ArrowLeft') target = keys[(index - 1 + keys.length) % keys.length]
    if (event.key === 'ArrowRight') target = keys[(index + 1) % keys.length]
    if (event.key === 'Home') target = keys[0]
    if (event.key === 'End') target = keys[keys.length - 1]
    if (!target) return
    event.preventDefault()
    const tab = tabs[keys.indexOf(target)]
    if (tab) onActivate(tab)
    buttonRefs.current.get(target)?.focus()
  }

  const closeTab = (tab: RightSurfaceTab): void => {
    const key = rightSurfaceTabKey(tab)
    const index = keys.indexOf(key)
    const neighbour = keys[index + 1] ?? keys[index - 1] ?? null
    pendingCloseFocusRef.current = { closingKey: key, targetKey: key === activeKey ? neighbour : activeKey }
    onClose(tab)
  }

  return <div className="surface-tabs" ref={listRef} role="tablist" aria-label="已打开的 Surface">
    {tabs.map((tab) => {
      const key = rightSurfaceTabKey(tab)
      const selected = activeKey === key
      const label = tabLabel(tab, sideChatTitles)
      const status = tab.type === 'side-chat' ? sideChatStatus?.get(tab.conversationId) : undefined
      return (
        <div ref={(node) => { itemRefs.current.set(key, node) }} className={`surface-tab${selected ? ' active' : ''}`}
          role="presentation" key={key} data-surface-tab={tab.type} data-side-chat-tab-id={tab.type === 'side-chat' ? tab.conversationId : undefined}>
          <button
            ref={(node) => { buttonRefs.current.set(key, node) }}
            id={`${rootId}-${key}-tab`}
            className="surface-tab-activate"
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${rootId}-${key}-panel`}
            tabIndex={selected || (!activeKey && keys[0] === key) ? 0 : -1}
            // The full title stays available through the accessible name and tooltip;
            // only the visual label is truncated.
            title={label}
            onClick={() => onActivate(tab)}
            onKeyDown={(event) => move(event, key)}
          >
            <Icon name={toolIcon(tab)} className="surface-icon" />
            <span className="label">{label}</span>
            {status && <span className="surface-tab-status" data-side-chat-tab-status>{status}</span>}
          </button>
          <button
            className="surface-tab-close"
            type="button"
            aria-label={`关闭 ${label}`}
            title={`关闭 ${label}`}
            onClick={() => closeTab(tab)}
          >
            <Icon name="x" />
          </button>
        </div>
      )
    })}
    <span ref={indicatorRef} className="motion-tab-indicator" aria-hidden="true" />
  </div>
}

/** Panel ids are derived from the same flat key, so `aria-controls` matches the body. */
export function rightSurfacePanelId(rootId: string, key: string): string {
  return `${rootId}-${key}-panel`
}
