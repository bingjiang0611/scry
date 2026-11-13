import { useEffect, useRef, useState, type RefObject } from 'react'

export interface PickerOpenProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function usePickerOpen(controlledOpen?: boolean, onOpenChange?: (open: boolean) => void) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    const value = typeof next === 'function' ? next(open) : next
    // A sibling picker may share the owner; a no-op close must not dismiss its menu.
    if (value === open) return
    if (controlledOpen === undefined) setLocalOpen(value)
    onOpenChange?.(value)
  }
  return [open, setOpen] as const
}

/**
 * 下拉菜单的共用交互：打开后焦点进入第一个可用选项，Esc 或外部点击关闭；
 * 关闭时若焦点还在菜单里，退回触发器，避免焦点落到 body。
 */
export function useMenuDismiss({
  open,
  close,
  rootRef,
  triggerRef,
  menuRef
}: {
  open: boolean
  close: () => void
  rootRef: RefObject<HTMLElement>
  triggerRef: RefObject<HTMLElement>
  menuRef: RefObject<HTMLElement>
}): void {
  // close 每次渲染都是新函数；用 ref 持有它，避免菜单打开时因父组件重渲染而重跑焦点与监听。
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(
      () => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(),
      0
    )
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeRef.current()
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
      closeRef.current()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open, rootRef, triggerRef, menuRef])
}

export interface RunControlSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}
