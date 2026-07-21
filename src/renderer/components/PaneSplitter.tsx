import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

export interface PaneSplitterProps {
  className?: string
  label: string
  controls: string
  min: number
  max: number
  value: number
  collapsed?: boolean
  active?: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function PaneSplitter({
  className = '',
  label,
  controls,
  min,
  max,
  value,
  collapsed = false,
  active = false,
  onPointerDown,
  onKeyDown
}: PaneSplitterProps) {
  return (
    <div
      className={`pane-resizer ${className}${active ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={collapsed ? min : value}
      aria-valuetext={collapsed ? 'collapsed' : `${value} px`}
      tabIndex={0}
      title={`${label}：方向键调整，Home/End 到最小/最大，Enter 折叠或恢复`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}
