import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain ESM script shared with the CLI audit; no type declarations.
import { auditCss, auditRenderer, auditRendererScope, countsOf, readBaseline, regressions, totalsOf } from '../../scripts/design-system-audit.mjs'

type Counts = Record<string, Record<string, number>>

const rendererDirectory = __dirname
const themeShell = readFileSync(join(rendererDirectory, 'styles-theme-shell.css'), 'utf8')

const TYPE_SCALE = { '2xs': 10, xs: 11, sm: 12, md: 13, base: 14, reading: 15, lg: 16, xl: 20, '2xl': 24 }
const WEIGHTS = { regular: 400, medium: 500, semibold: 600, bold: 700 }
const SPACE = { '0_5': 2, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 }
const TOKEN_DEFINITION = /--(?:text-(?:2xs|xs|sm|md|base|reading|lg|xl|2xl)|weight-[a-z]+|space-[0-9_]+)\s*:/

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
    `)
    expect(found.fontSize.map((item: { text: string }) => item.text)).toEqual(['font: var(--weight-semibold) 11.5px/1 var(--font-mono)'])
    expect(found.fontWeight.map((item: { text: string }) => item.text)).toEqual(['font-weight: 550'])
    expect(found.spacing.map((item: { text: string }) => item.text)).toEqual(['padding: 6px var(--space-2)', 'margin: -3px 0 2px'])
    expect(found.color.map((item: { text: string }) => item.text)).toEqual(['color: #fff'])
    // A bare :not() raises specificity and overrides component rules, so only the :where() form counts.
    expect(found.buttonReset.map((item: { text: string }) => item.text)).toEqual(['.d button:hover', '.g button:not(.btn):hover'])
  })

  it('only lets renderer design debt shrink', () => {
    const counts: Counts = countsOf(auditRenderer())
    expect(regressions(counts, readBaseline()), 'Use var(--text-*), var(--weight-*), a 4px-grid spacing value, theme color variables, and exclude primitives from container button rules. See DESIGN.md.').toEqual([])
  })

  it('records paid-down debt so it cannot silently return', () => {
    const counts: Counts = countsOf(auditRenderer())
    const baseline = readBaseline()
    expect(totalsOf(counts), 'Debt went down: run `npm run design:audit -- --write` to lower the baseline.').toEqual(baseline.totals)
  })
})

describe('cleaned areas', () => {
  // Areas whose debt has been paid off in full are held at zero, not just ratcheted.
  const CLEAN = {
    sidebar: /(^|[\s,>+~(])\.(sb-|sidebar\b|sidebar-)/,
    // Conversation and tool evidence: selectors whose first class belongs to these families.
    conversation: /^[^.,]*\.(?:turn|chat|hooks?|tool|md|mdiv|transcript|question|thinking|user-md|user-attachments?|subagent|callrow|callserver|model-text)(?:-[\w-]*)?(?![\w-])/,
    // Composer, its pickers and queue, and the welcome screen around it.
    composer: /^[^.,]*\.(?:composer|runtime-composer|runtime|queue|slash|model-effort|wdbtn|clibtn|climenu|clipick|location|welcome|wc|draft-attachments?|permission-mode|pending-submission|send|stop|steer|agicon|image-lightbox|bubble|who)(?:-[\w-]*)?(?![\w-])/,
    // Overview panel, evidence graph, segments, verdict, pinned summary and run status.
    overview: /^[^.,]*\.(?:overview|ov|evidence|seg|segment|segments|graph|gp|verdict|pinned|ctx|billing|panel|stat|top-tools|toptool|tt|kv|background|agents?|psrc|run-status|recorder)(?:-[\w-]*)?(?![\w-])/
  }

  it.each(Object.entries(CLEAN))('%s rules use only scale tokens, the 4px grid and theme colors', (_, scope) => {
    const debt = Object.entries(auditRendererScope(scope)).flatMap(([file, found]) =>
      Object.entries(found as Record<string, Array<{ line: number, text: string }>>).flatMap(([metric, items]) => items.map((item) => `${file}:${item.line} ${metric} ${item.text}`)))
    expect(debt).toEqual([])
  })
})
