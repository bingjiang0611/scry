import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './Button'
import { IconButton } from './IconButton'

const rendererRoot = join(__dirname, '../..')

function files(directory: string, suffix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path, suffix)
    return entry.isFile() && entry.name.endsWith(suffix) ? [path] : []
  })
}

describe('Button', () => {
  it('never submits a form unless the caller asks for submit', () => {
    expect(renderToStaticMarkup(<Button>取消</Button>)).toBe('<button type="button" class="btn">取消</button>')
    expect(renderToStaticMarkup(<Button variant="primary" type="submit">保存</Button>))
      .toBe('<button type="submit" class="btn primary">保存</button>')
  })

  it('maps variant and size to the shared classes and keeps hook classes and DOM props', () => {
    const ref = createRef<HTMLButtonElement>()
    expect(renderToStaticMarkup(
      <Button ref={ref} variant="quiet" size="sm" className="turn-branch-btn" disabled aria-label="创建分支">分支</Button>
    )).toBe('<button disabled="" aria-label="创建分支" type="button" class="btn quiet sm turn-branch-btn">分支</button>')
    expect(renderToStaticMarkup(<Button variant="danger">删除</Button>)).toBe('<button type="button" class="btn danger">删除</button>')
  })
})

describe('IconButton', () => {
  it('always has an accessible name and a tooltip', () => {
    expect(renderToStaticMarkup(<IconButton label="刷新文件">↻</IconButton>))
      .toBe('<button type="button" aria-label="刷新文件" title="刷新文件" class="icon-button">↻</button>')
  })

  it('keeps a distinct tooltip and marks the active state without owning aria state', () => {
    expect(renderToStaticMarkup(<IconButton label="最大化右侧工作区" title="最大化面板" size="sm" active aria-pressed>⤢</IconButton>))
      .toBe('<button aria-pressed="true" type="button" aria-label="最大化右侧工作区" title="最大化面板" class="icon-button sm on">⤢</button>')
  })
})

describe('button convergence', () => {
  it('defines button visuals in one stylesheet only', () => {
    const forks = files(rendererRoot, '.css')
      .filter((path) => !path.endsWith('styles-buttons.css'))
      .flatMap((path) => Array.from(readFileSync(path, 'utf8').matchAll(/^\s*(\.btn(?:\.(?:primary|danger|quiet|sm))?|\.icon-button(?:\.(?:sm|on))?)\s*\{/gm), (match) => `${path}: ${match[1]}`))
    expect(forks).toEqual([])
  })

  it('does not reintroduce the retired parallel button classes', () => {
    const retired = /\b(?:hosts-button|mp-button|mp-icon-button|mp-primary|mp-back|mp-danger|iconbtn|icon-btn)\b/
    const offenders = [...files(rendererRoot, '.css'), ...files(rendererRoot, '.tsx')]
      .filter((path) => !path.endsWith('Button.test.tsx'))
      .filter((path) => retired.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('renders text and icon buttons through the primitives instead of hand-written classes', () => {
    const handWritten = /className=(?:"|\{?`|\{')(?:btn|icon-button)(?:[\s"'`$]|$)/
    const offenders = files(rendererRoot, '.tsx')
      .filter((path) => !/primitives[\\/](?:Button|IconButton)(?:\.test)?\.tsx$/.test(path))
      .filter((path) => handWritten.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
