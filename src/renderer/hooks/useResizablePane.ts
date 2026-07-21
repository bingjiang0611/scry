import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

export type ResizablePaneSide = 'left' | 'right'

export interface ResizablePaneOptions {
  id: string
  defaultWidth: number
  min: number
  max: number
  step?: number
  side: ResizablePaneSide
}

export interface ResizablePaneState {
  width: number
  visibleWidth: number
  collapsed: boolean
  resizing: boolean
  min: number
  max: number
  startResize: (event: ReactPointerEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  collapse: () => void
  restore: () => void
  setToMin: () => void
  setToMax: () => void
}

interface StoredPane {
  width?: number
  restoreWidth?: number
  collapsed?: boolean
}

const DEFAULT_STEP = 16

export const clampPaneWidth = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export const resizePaneWidth = (
  startWidth: number,
  deltaX: number,
  side: ResizablePaneSide,
  min: number,
  max: number
): number => clampPaneWidth(startWidth + (side === 'left' ? deltaX : -deltaX), min, max)

export const nudgePaneWidth = (
  width: number,
  key: 'ArrowLeft' | 'ArrowRight',
  side: ResizablePaneSide,
  step: number,
  min: number,
  max: number
): number => clampPaneWidth(width + (key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? step : -step), min, max)

const storageKey = (id: string): string => `scry:pane:${id}`

function readStoredPane(id: string): StoredPane {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(window.localStorage.getItem(storageKey(id)) ?? '{}') as StoredPane
  } catch {
    return {}
  }
}

function writeStoredPane(id: string, value: StoredPane): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(value))
  } catch {
    // localStorage can be unavailable in hardened desktop contexts; layout still works in memory.
  }
}

export function useResizablePane({
  id,
  defaultWidth,
  min,
  max,
  step = DEFAULT_STEP,
  side
}: ResizablePaneOptions): ResizablePaneState {
  const stored = useMemo(() => readStoredPane(id), [id])
  const initialWidth = clampPaneWidth(stored.width ?? defaultWidth, min, max)
  const [width, setWidth] = useState(initialWidth)
  const [restoreWidth, setRestoreWidth] = useState(clampPaneWidth(stored.restoreWidth ?? initialWidth, min, max))
  const [collapsed, setCollapsed] = useState(stored.collapsed ?? false)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    writeStoredPane(id, { width, restoreWidth, collapsed })
  }, [id, width, restoreWidth, collapsed])

  const setPaneWidth = useCallback(
    (next: number) => {
      const clamped = clampPaneWidth(next, min, max)
      setWidth(clamped)
      setRestoreWidth(clamped)
      setCollapsed(false)
    },
    [max, min]
  )

  const collapse = useCallback(() => {
    setRestoreWidth(width)
    setCollapsed(true)
  }, [width])

  const restore = useCallback(() => {
    setWidth((current) => clampPaneWidth(restoreWidth || current || defaultWidth, min, max))
    setCollapsed(false)
  }, [defaultWidth, max, min, restoreWidth])

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = collapsed ? restoreWidth : width
      setCollapsed(false)
      setResizing(true)
      document.body.classList.add('pane-resizing')

      const onMove = (moveEvent: PointerEvent): void => {
        setPaneWidth(resizePaneWidth(startWidth, moveEvent.clientX - startX, side, min, max))
      }
      const stop = (): void => {
        setResizing(false)
        document.body.classList.remove('pane-resizing')
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    },
    [collapsed, max, min, restoreWidth, setPaneWidth, side, width]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        collapsed ? restore() : collapse()
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        setPaneWidth(min)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        setPaneWidth(max)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        setPaneWidth(nudgePaneWidth(collapsed ? restoreWidth : width, event.key, side, step, min, max))
      }
    },
    [collapse, collapsed, max, min, restore, restoreWidth, setPaneWidth, side, step, width]
  )

  return {
    width,
    visibleWidth: collapsed ? 0 : width,
    collapsed,
    resizing,
    min,
    max,
    startResize,
    onKeyDown,
    collapse,
    restore,
    setToMin: () => setPaneWidth(min),
    setToMax: () => setPaneWidth(max)
  }
}
