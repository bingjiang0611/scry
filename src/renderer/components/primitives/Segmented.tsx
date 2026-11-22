import type { ReactNode } from 'react'

export type SegmentedOption<T extends string | number> = { value: T; label: ReactNode; title?: string; disabled?: boolean }

type SegmentedProps<T extends string | number> = {
  /** Accessible name of the group. */
  label: string
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  /** Hook class for placement and UI checks; never for restyling the control. */
  className?: string
}

/**
 * A small set of mutually exclusive options that filter or re-scope the same
 * content and apply immediately. Use Tabs instead when the choice swaps
 * whole panels. Each option is a pressed/unpressed toggle in one group.
 */
export function Segmented<T extends string | number>({ label, value, onChange, options, className }: SegmentedProps<T>) {
  return (
    <div className={className ? `segmented ${className}` : 'segmented'} role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          title={option.title}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
