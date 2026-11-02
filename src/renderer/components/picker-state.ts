import { useState } from 'react'

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

export interface RunControlSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}
