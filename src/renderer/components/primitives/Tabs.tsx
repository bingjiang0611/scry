import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react'

export type TabItem<T extends string> = {
  value: T
  label: ReactNode
  /** Rendered after the label in the tabular count style; omit while unknown instead of passing 0. */
  count?: ReactNode
  /** DOM id of the tab, kept stable for aria-labelledby and UI checks. */
  id?: string
  /** id of the tabpanel this tab controls, when one exists. */
  controls?: string
  title?: string
}

type TabsProps<T extends string> = {
  label: string
  value: T
  onChange: (value: T) => void
  items: readonly TabItem<T>[]
  /** Hook class for placement and UI checks; never for restyling the tabs. */
  className?: string
  orientation?: 'horizontal' | 'vertical'
  listRef?: Ref<HTMLDivElement>
  /** Lets a caller measure tabs, e.g. for a moving selection indicator. */
  tabRef?: (value: T, node: HTMLButtonElement | null) => void
  /** Decoration appended inside the tablist, such as an indicator element. */
  children?: ReactNode
}

export function nextTabIndex(key: string, current: number, count: number): number {
  if (count === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight') return (current + 1) % count
  if (key === 'ArrowLeft') return (current - 1 + count) % count
  return -1
}

/**
 * In-view tabs with automatic activation: Arrow keys, Home and End move both
 * focus and selection, and only the selected tab is in the Tab order. Selection
 * color switches in the same frame as aria-selected; there is no color tween.
 */
export function Tabs<T extends string>({ label, value, onChange, items, className, orientation = 'horizontal', listRef, tabRef, children }: TabsProps<T>) {
  const nodes = useRef(new Map<T, HTMLButtonElement>())
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = orientation === 'vertical'
      ? ({ ArrowUp: 'ArrowLeft', ArrowDown: 'ArrowRight', Home: 'Home', End: 'End' } as Record<string, string>)[event.key]
      : event.key
    if (!key) return
    const index = nextTabIndex(key, items.findIndex(item => item.value === value), items.length)
    if (index < 0) return
    event.preventDefault()
    const next = items[index].value
    onChange(next)
    nodes.current.get(next)?.focus()
  }
  return (
    <div ref={listRef} className={className ? `tabs ${className}` : 'tabs'} role="tablist" aria-label={label} aria-orientation={orientation === 'vertical' ? orientation : undefined} onKeyDown={move}>
      {items.map(item => (
        <button
          key={item.value}
          id={item.id}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          aria-controls={item.controls}
          tabIndex={item.value === value ? 0 : -1}
          title={item.title}
          ref={node => {
            if (node) nodes.current.set(item.value, node)
            else nodes.current.delete(item.value)
            tabRef?.(item.value, node)
          }}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined && item.count !== null && <span className="tab-count">{item.count}</span>}
        </button>
      ))}
      {children}
    </div>
  )
}
