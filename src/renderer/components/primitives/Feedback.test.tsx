import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Notice } from './Notice'
import { Segmented } from './Segmented'
import { Tabs, nextTabIndex } from './Tabs'

const rendererRoot = join(__dirname, '../..')
const noop = () => undefined

function files(directory: string, suffix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path, suffix)
    return entry.isFile() && entry.name.endsWith(suffix) ? [path] : []
  })
}

describe('Notice', () => {
  it('carries tone by icon and class and leaves the live-region role to the caller', () => {
    const html = renderToStaticMarkup(<Notice tone="warn" className="hosts-alert">读取失败</Notice>)
    expect(html).toContain('class="notice warn hosts-alert"')
    expect(html).not.toContain('role=')
    expect(html).toContain('class="ico notice-icon"')
    expect(html).toContain('<div class="notice-body">读取失败</div>')
  })

  it('renders strip and compact layouts and an optional action slot', () => {
    expect(renderToStaticMarkup(<Notice layout="strip" role="status">x</Notice>)).toMatch(/^<div role="status" class="notice info strip">/)
    const html = renderToStaticMarkup(<Notice tone="bad" size="sm" action={<button type="button">重试</button>}>x</Notice>)
    expect(html).toContain('class="notice bad sm"')
    expect(html).toContain('<div class="notice-actions"><button type="button">重试</button></div>')
  })
})

describe('Tabs', () => {
  it('keeps only the selected tab in the Tab order and preserves ids, panels and counts', () => {
    const html = renderToStaticMarkup(<Tabs className="overview-data-tabs" label="数据维度" value="turns" onChange={noop} items={[
      { value: 'turns', label: '轮次数据', id: 'overview-turns-tab', controls: 'overview-turns-panel' },
      { value: 'session', label: '会话数据', count: 3, id: 'overview-session-tab' }
    ]} />)
    expect(html).toMatch(/^<div class="tabs overview-data-tabs" role="tablist" aria-label="数据维度">/)
    expect(html).toMatch(/id="overview-turns-tab"[^>]*aria-selected="true"[^>]*aria-controls="overview-turns-panel"[^>]*tabindex="0"/)
    expect(html).toMatch(/id="overview-session-tab"[^>]*aria-selected="false"[^>]*tabindex="-1"/)
    expect(html).toContain('会话数据<span class="tab-count">3</span>')
  })

  it('moves with arrow keys, Home and End and wraps at both ends', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(nextTabIndex('Home', 2, 3)).toBe(0)
    expect(nextTabIndex('End', 0, 3)).toBe(2)
    expect(nextTabIndex('Enter', 0, 3)).toBe(-1)
    expect(nextTabIndex('ArrowRight', -1, 0)).toBe(-1)
  })
})

describe('Segmented', () => {
  it('is a labelled group of pressed toggles, not a tablist', () => {
    const html = renderToStaticMarkup(<Segmented className="usage-segmented" label="时间范围" value={30} onChange={noop} options={[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }]} />)
    expect(html).toBe('<div class="segmented usage-segmented" role="group" aria-label="时间范围"><button type="button" aria-pressed="false">7 天</button><button type="button" aria-pressed="true">30 天</button></div>')
  })
})

describe('notice and tab convergence', () => {
  it('defines notice, tab and segmented visuals in their own stylesheets only', () => {
    const forks = files(rendererRoot, '.css')
      .filter((path) => !/styles-(?:notices|tabs)\.css$/.test(path))
      .flatMap((path) => Array.from(readFileSync(path, 'utf8').matchAll(/^\s*(\.notice(?:\.[a-z]+)?|\.tabs(?: \[role='tab'\])?|\.segmented(?: button)?)\s*\{/gm), (match) => `${path}: ${match[1]}`))
    expect(forks).toEqual([])
  })

  it('does not reintroduce retired notice and tab families or hand-written tablists', () => {
    const retired = /\.(?:vtabs?|panel-tabs)\b|\.sc-tabs button\[aria-pressed/
    const handTablist = /role="tablist"/
    const offenders = files(rendererRoot, '.tsx')
      .filter((path) => !/primitives[\\/]Tabs\.tsx$/.test(path) && !/\.test\.tsx$|[\\/]render-tests[\\/]/.test(path))
      // Closable, draggable strips keep their own implementation by design.
      .filter((path) => !/(?:RightSurfaceTabStrip|TerminalSurface)\.tsx$/.test(path))
      .filter((path) => handTablist.test(readFileSync(path, 'utf8')))
    const css = files(rendererRoot, '.css').filter((path) => retired.test(readFileSync(path, 'utf8')))
    expect([...offenders, ...css]).toEqual([])
  })
})
