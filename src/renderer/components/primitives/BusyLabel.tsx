import type { ReactNode } from 'react'

/**
 * The inside of a text button that may be busy. The label keeps its box (so the
 * button's width never changes) and a spinner takes its place once the shared
 * delay has passed; the button's accessible name stays the label.
 */
export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <span className="busy-label" data-busy={busy || undefined}>
      <span className="busy-label-text">{children}</span>
      {busy && <span className="spinner busy-label-spinner" aria-hidden="true" />}
    </span>
  )
}
