import type { CSSProperties } from 'react'

import { useDelayedFlag } from '../../hooks/useDelayedFlag'

import './skeleton.css'

// Line lengths vary a little, and are always shorter than real text, so the
// placeholder never reads as content. Deterministic so renders stay stable.
const PRIMARY_WIDTHS = [72, 58, 84, 64, 78, 52, 68, 60] as const
const SECONDARY_WIDTHS = [44, 36, 52, 40, 48, 32, 46, 38] as const

export type SkeletonRowsProps = {
  rows: number
  /** Accessible name; announced once by the status role, never per shape. */
  label: string
  /** Matches the real row's outer height so nothing moves when data arrives. */
  rowHeight?: number
  meta?: boolean
  /** A leading circle at the real picture/icon size. */
  avatar?: number
  className?: string
}

export function SkeletonRows({ rows, label, rowHeight, meta = false, avatar, className = '' }: SkeletonRowsProps) {
  const style = {
    ...(rowHeight ? { '--sk-row-height': `${rowHeight}px` } : {}),
    // The row gap is 10px; text after a picture shifts its band back by that much.
    ...(avatar ? { '--sk-avatar-offset': `${avatar + 10}px` } : {})
  } as CSSProperties
  return (
    <div className={`skeleton-rows ${className}`.trim()} role="status" aria-label={label} style={style}>
      {Array.from({ length: Math.max(0, rows) }, (_, index) => (
        <div className="skeleton-row" key={index} aria-hidden="true">
          {avatar ? <span className="sk-shape sk-circle" style={{ width: avatar, height: avatar }} /> : null}
          <span className="skeleton-row-copy">
            <span className="sk-shape sk-text" style={{ width: `${PRIMARY_WIDTHS[index % PRIMARY_WIDTHS.length]}%` }} />
            {meta && <span className="sk-shape sk-text sk-meta" style={{ width: `${SECONDARY_WIDTHS[index % SECONDARY_WIDTHS.length]}%` }} />}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Row shapes that appear only after the shared delay, so a fast read never flashes them. */
export function DelayedSkeletonRows({ loading, ...props }: SkeletonRowsProps & { loading: boolean }) {
  const visible = useDelayedFlag(loading)
  return loading && visible ? <SkeletonRows {...props} /> : null
}
