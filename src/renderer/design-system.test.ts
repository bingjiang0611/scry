import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM script shared with the CLI audit; no type declarations.
import { METRIC_RULES, auditCss, auditRenderer } from '../../scripts/design-system-audit.mjs'

type Findings = Record<string, Record<string, Array<{ line: number, text: string }>>>

const rendererDirectory = __dirname
const themeShell = readFileSync(join(rendererDirectory, 'styles-theme-shell.css'), 'utf8')

const TYPE_SCALE = { '2xs': 10, xs: 11, sm: 12, md: 13, base: 14, reading: 15, lg: 16, xl: 20, '2xl': 24 }
const WEIGHTS = { regular: 400, medium: 500, semibold: 600, bold: 700 }
const SPACE = { '0_5': 2, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 }
// Menus open from drawers, so they sit above them; modals cover every menu.
const LAYERS = { overlay: 100, dropdown: 200, modal: 300, 'modal-dropdown': 400, tooltip: 500 }
const TOKEN_DEFINITION = /--(?:text-(?:2xs|xs|sm|md|base|reading|lg|xl|2xl)|weight-[a-z]+|space-[0-9_]+|layer-[a-z-]+)\s*:/

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : []
  })
}

describe('design tokens', () => {
  it('defines one type, weight and 4px spacing scale in the theme shell', () => {
    for (const [name, px] of Object.entries(TYPE_SCALE)) expect(themeShell).toContain(`--text-${name}: ${px}px;`)
    for (const [name, weight] of Object.entries(WEIGHTS)) expect(themeShell).toContain(`--weight-${name}: ${weight};`)
    for (const [name, value] of Object.entries(LAYERS)) expect(themeShell).toContain(`--layer-${name}: ${value};`)
    for (const [name, px] of Object.entries(SPACE)) {
      expect(themeShell).toContain(`--space-${name}: ${px}px;`)
      expect(px === 2 || px % 4 === 0).toBe(true)
    }
    expect(themeShell).toContain('--text-supporting-size: var(--text-sm);')
    expect(themeShell).toContain('--text-compact-size: var(--text-xs);')
  })

  it('keeps scale definitions in a single place so a theme or skin cannot fork them', () => {
    const forks = cssFiles(rendererDirectory)
      .filter((path) => !path.endsWith('styles-theme-shell.css'))
      .filter((path) => TOKEN_DEFINITION.test(readFileSync(path, 'utf8')))
    expect(forks).toEqual([])
  })
})

describe('design debt audit', () => {
  it('flags off-scale type, off-grid spacing and raw colors but not tokens', () => {
    const found = auditCss(`
      .a:hover { padding: 6px var(--space-2); font: var(--weight-semibold) 11.5px/1 var(--font-mono); color: #fff; --x: #000 }
      @media (max-width: 640px) { .b { margin: -3px 0 2px; gap: 1px 8px; font-weight: 550; font-size: clamp(24px, 3cqi, 32px) } }
      .c { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--fg); padding: 4px 12px }
      .d button:hover, .e button:not(:where(.btn, .icon-button, [role='tab'])):hover, .g button:not(.btn):hover, .f .btn { cursor: pointer }
      :root[data-platform='macos'] .topbar button, .h button { -webkit-app-region: no-drag; user-select: none }
      .i { z-index: 1200 } .j { z-index: 16 } .k { z-index: var(--layer-dropdown) } .l { z-index: calc(var(--layer-dropdown) + 1) }
    `)
    expect(found.fontSize.map((item: { text: string }) => item.text)).toEqual(['font: var(--weight-semibold) 11.5px/1 var(--font-mono)'])
    expect(found.fontWeight.map((item: { text: string }) => item.text)).toEqual(['font-weight: 550'])
    expect(found.spacing.map((item: { text: string }) => item.text)).toEqual(['padding: 6px var(--space-2)', 'margin: -3px 0 2px'])
    expect(found.color.map((item: { text: string }) => item.text)).toEqual(['color: #fff'])
    // Floating layers use the named scale; small literals only order siblings inside one component.
    expect(found.layer.map((item: { text: string }) => item.text)).toEqual(['z-index: 1200'])
    // A bare :not() raises specificity and overrides component rules, so only the :where() form counts.
    // Behavior-only rules (window drag band, pointer events, selection) must keep reaching every button.
    expect(found.buttonReset.map((item: { text: string }) => item.text)).toEqual(['.d button:hover', '.g button:not(.btn):hover'])
  })

  it('keeps primitives inside the macOS titlebar drag opt-out', () => {
    // Without no-drag a Button or IconButton in the 52px titlebar becomes part of the window drag band and stops receiving clicks.
    const macWindow = readFileSync(join(rendererDirectory, 'styles-macos-window.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const noDrag = [...macWindow.matchAll(/([^{}]+)\{[^{}]*-webkit-app-region:\s*no-drag/g)]
      .flatMap((match) => match[1].split(',').map((selector) => selector.trim()))
    expect(noDrag).toEqual(expect.arrayContaining([":root[data-platform='macos'] .topbar button", ":root[data-platform='macos'] .surface-topbar button"]))
  })

  it('finds no design debt in any renderer stylesheet', () => {
    // Every stylesheet uses the type and weight tokens, the 4px grid, theme colors, and
    // container button rules that leave the primitives alone. There is no baseline:
    // any finding is a regression. `npm run design:audit -- --verbose` prints the same list.
    const debt = Object.entries(auditRenderer() as Findings).flatMap(([file, found]) =>
      Object.entries(found).flatMap(([metric, items]) => items.map((item) => `${file}:${item.line} ${metric}: ${item.text}`)))
    expect(debt, Object.values(METRIC_RULES).join('\n')).toEqual([])
  })
})
