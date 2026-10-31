import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererDirectory = __dirname
const themeShell = readFileSync(join(rendererDirectory, 'styles-theme-shell.css'), 'utf8')
const alignedShell = readFileSync(join(rendererDirectory, 'codex-alignment-shell.css'), 'utf8')

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return cssFiles(path)
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : []
  })
}

function cssRules(source: string): string[] {
  return Array.from(source.matchAll(/[^{}]+\{([^{}]*)\}/g), (match) => match[1])
}

describe('renderer radius system', () => {
  it('uses one 4px-grid token scale from outer surfaces to inner details', () => {
    expect(themeShell).toContain('--r-xs: 4px')
    expect(themeShell).toContain('--r-sm: 8px')
    expect(themeShell).toContain('--r-md: 12px')
    expect(themeShell).toContain('--r-lg: 20px')
    expect(themeShell).toContain('--r-pill: 999px')
    expect(alignedShell).not.toMatch(/--r-(?:xs|sm|md|lg|pill):/)
  })

  it('keeps component radii on shared tokens instead of local pixel values', () => {
    const violations = cssFiles(rendererDirectory).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return Array.from(source.matchAll(/border-radius\s*:\s*([^;]+);/g), (match) => match[1].trim())
        .filter((value) => value
          .replace(/var\(--r-(?:xs|sm|md|lg|pill)\)|50%|0/g, '')
          .trim() !== '')
        .map((value) => `${path}: ${value}`)
    })

    expect(violations).toEqual([])
  })

  it('progressively enhances continuous corners while preserving round geometry', () => {
    expect(themeShell).toContain('@supports (corner-shape: superellipse(1.25))')
    expect(themeShell).toMatch(/:where\(\*\)\s*\{\s*corner-shape: superellipse\(1\.25\)/)

    const missingRoundShape = cssFiles(rendererDirectory).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return cssRules(source)
        .filter((rule) => /border-radius\s*:\s*(?:50%|var\(--r-pill\))\s*;/.test(rule))
        .filter((rule) => !/corner-shape\s*:\s*round\s*;/.test(rule))
        .map(() => path)
    })

    expect(missingRoundShape).toEqual([])
  })
})
