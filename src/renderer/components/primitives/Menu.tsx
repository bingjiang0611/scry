import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * Command menus (WAI-ARIA menu pattern). The primitive owns the surface, the item
 * contract and keyboard movement; the caller owns placement, open state, dismissal and
 * motion, because those differ per menu (anchored picker, context menu, portal).
 *
 * Pickers with a search field or extra controls in a row are panels, not menus
 * (role="dialog" or a listbox), and do not use this.
 */

const ITEM_SELECTOR = ['menuitem', 'menuitemradio', 'menuitemcheckbox']
  .map((role) => `[role="${role}"]:not(:disabled):not([aria-disabled="true"])`).join(',')

type MenuItemNode = { focus: () => void; textContent: string | null; getAttribute: (name: string) => string | null }
type MenuNode = { querySelectorAll: (selector: string) => ArrayLike<MenuItemNode> } | null

/** The enabled items of a menu in DOM order. */
export function menuItems(menu: MenuNode): MenuItemNode[] {
  return Array.from(menu?.querySelectorAll(ITEM_SELECTOR) ?? [])
}

const itemLabel = (item: MenuItemNode): string =>
  (item.getAttribute('aria-label') ?? item.textContent ?? '').trim().toLocaleLowerCase()

/**
 * Index of the item a key moves focus to, or -1 when the key is not a menu key.
 * Arrows wrap; Home/End go to the ends; a printable character moves to the next item
 * whose label starts with it (typeahead), searching forward from the current item.
 */
export function nextMenuIndex(key: string, current: number, labels: readonly string[]): number {
  const count = labels.length
  if (count === 0) return -1
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key.length !== 1 || !key.trim()) return -1
  const char = key.toLocaleLowerCase()
  for (let step = 1; step <= count; step += 1) {
    const index = (current + step + count) % count
    if (labels[index].startsWith(char)) return index
  }
  return -1
}

/**
 * Moves focus inside a menu for a key press. Returns whether the key was handled, so a
 * caller can layer its own keys (Tab, Escape, submenus) around it.
 */
export function menuKeyDown(
  event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void },
  menu: MenuNode
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false
  const items = menuItems(menu)
  const active: unknown = typeof document === 'undefined' ? null : document.activeElement
  const index = nextMenuIndex(event.key, items.findIndex((item) => item === active), items.map(itemLabel))
  if (index < 0) return false
  event.preventDefault()
  items[index].focus()
  return true
}

type MenuProps = HTMLAttributes<HTMLDivElement> & {
  /** Accessible name of the menu. */
  label: string
}

/** The menu surface. `className` carries placement and test hooks only. */
export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu({ label, className, onKeyDown, children, ...rest }, ref) {
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (!event.defaultPrevented) menuKeyDown(event, event.currentTarget)
  }
  return <div ref={ref} role="menu" aria-label={label} className={className ? `menu-surface ${className}` : 'menu-surface'} onKeyDown={keyDown} {...rest}>
    {children}
  </div>
})

/**
 * Single-select menus keep a check column on every item, selected or not, so labels start
 * in the same column. The selected state is aria-checked; the mark is only visual.
 */
export function MenuCheck({ selected }: { selected: boolean }) {
  return <span className="menu-check" aria-hidden="true">{selected ? <Icon name="check" /> : null}</span>
}

type MenuItemProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> & {
  /** Present for single-select items: renders the check column and role="menuitemradio". */
  checked?: boolean
  /** Destructive action: red label; place it last in the menu. */
  danger?: boolean
  /** Leading icon. Give every item in a menu an icon, or none. */
  icon?: ReactNode
  /** Trailing note such as a shortcut or a short state; pushed to the end of the row. */
  trailing?: ReactNode
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { checked, danger, icon, trailing, className, type = 'button', children, ...rest },
  ref
) {
  const classes = ['mitem', danger && 'danger', className].filter(Boolean).join(' ')
  return <button ref={ref} type={type} role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} className={classes} {...rest}>
    {checked !== undefined && <MenuCheck selected={checked} />}
    {icon}
    {children}
    {trailing !== undefined && trailing !== null && <span className="mitem-trailing">{trailing}</span>}
  </button>
})

export function MenuSeparator() {
  return <div className="mdiv" role="separator" />
}

/** A group heading inside a menu; not focusable. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="mhdr" role="none">{children}</div>
}
