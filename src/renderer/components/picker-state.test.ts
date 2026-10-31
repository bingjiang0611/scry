import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePickerOpen } from './picker-state'

const state = vi.hoisted(() => ({ localOpen: false, setLocalOpen: vi.fn() }))
vi.mock('react', () => ({ useState: () => [state.localOpen, state.setLocalOpen] }))

beforeEach(() => {
  state.localOpen = false
  vi.clearAllMocks()
})

describe('picker open notifications', () => {
  it.each([false, true])('does not notify the owner when controlled state stays %s', (open) => {
    const onOpenChange = vi.fn()
    const [, setOpen] = usePickerOpen(open, onOpenChange)
    setOpen(open)
    // A closed model picker reacting to loading must not dismiss the open Agent picker
    // that shares its owner. The isolated Side Chat App scenario covers that interaction.
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(state.setLocalOpen).not.toHaveBeenCalled()
  })

  it('requests a real controlled transition without changing local state', () => {
    const onOpenChange = vi.fn()
    const [, setOpen] = usePickerOpen(true, onOpenChange)
    setOpen(current => !current)
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
    expect(state.setLocalOpen).not.toHaveBeenCalled()
  })

  it('updates and notifies an uncontrolled picker only on a change', () => {
    const onOpenChange = vi.fn()
    const [, setOpen] = usePickerOpen(undefined, onOpenChange)
    setOpen(false)
    expect(onOpenChange).not.toHaveBeenCalled()
    setOpen(current => !current)
    expect(state.setLocalOpen).toHaveBeenCalledExactlyOnceWith(true)
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true)
  })
})
