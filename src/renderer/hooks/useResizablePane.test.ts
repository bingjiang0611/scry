import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PaneSplitter } from '../components/PaneSplitter'
import { clampPaneWidth, nudgePaneWidth, resizePaneWidth } from './useResizablePane'

describe('useResizablePane pure sizing helpers', () => {
  it('clamps pane width to configured bounds', () => {
    expect(clampPaneWidth(120, 220, 440)).toBe(220)
    expect(clampPaneWidth(500, 220, 440)).toBe(440)
    expect(clampPaneWidth(320, 220, 440)).toBe(320)
  })

  it('resizes left and right panes in opposite pointer directions', () => {
    expect(resizePaneWidth(256, 20, 'left', 220, 440)).toBe(276)
    expect(resizePaneWidth(340, 20, 'right', 280, 560)).toBe(320)
  })

  it('maps arrow keys to natural pane expansion directions', () => {
    expect(nudgePaneWidth(256, 'ArrowRight', 'left', 16, 220, 440)).toBe(272)
    expect(nudgePaneWidth(340, 'ArrowLeft', 'right', 16, 280, 560)).toBe(356)
  })

  it('keeps collapsed separator aria-valuenow inside configured bounds', () => {
    const html = renderToStaticMarkup(
      createElement(PaneSplitter, {
        label: '调整右侧面板宽度',
        controls: 'overview-pane',
        min: 280,
        max: 560,
        value: 340,
        collapsed: true,
        onPointerDown: () => {},
        onKeyDown: () => {}
      })
    )
    expect(html).toContain('aria-valuenow="280"')
    expect(html).toContain('aria-valuetext="collapsed"')
  })
})
