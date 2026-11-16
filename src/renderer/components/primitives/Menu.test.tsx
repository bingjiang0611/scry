import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu, MenuItem, MenuLabel, MenuSeparator, menuKeyDown, nextMenuIndex } from './Menu'

const rendererRoot = join(__dirname, '..', '..')

function files(directory: string, test: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path, test)
    return entry.isFile() && test(entry.name) ? [path] : []
  })
}

describe('Menu primitive', () => {
  it('renders the menu surface, item roles, check column, danger and trailing slots', () => {
    const html = renderToStaticMarkup(<Menu label="项目操作" className="menu sb-project-menu">
      <MenuLabel>Provider</MenuLabel>
      <MenuItem checked icon={<i>g</i>} data-provider-option="codex">Codex</MenuItem>
      <MenuItem checked={false}>Claude</MenuItem>
      <MenuSeparator />
      <MenuItem trailing="已打开">Diff</MenuItem>
      <MenuItem danger className="sb-project-remove">移除项目</MenuItem>
    </Menu>)
    expect(html).toContain('<div role="menu" aria-label="项目操作" class="menu-surface menu sb-project-menu">')
    expect(html).toContain('<div class="mhdr" role="none">Provider</div>')
    expect(html).toMatch(/<button type="button" role="menuitemradio" aria-checked="true" class="mitem" data-provider-option="codex"><span class="menu-check" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><i>g<\/i>Codex<\/button>/)
    expect(html).toContain('<button type="button" role="menuitemradio" aria-checked="false" class="mitem"><span class="menu-check" aria-hidden="true"></span>Claude</button>')
    expect(html).toContain('<div class="mdiv" role="separator"></div>')
    expect(html).toContain('<button type="button" role="menuitem" class="mitem">Diff<span class="mitem-trailing">已打开</span></button>')
    expect(html).toContain('<button type="button" role="menuitem" class="mitem danger sb-project-remove">移除项目</button>')
  })

  it('moves with arrows that wrap, Home and End, and typeahead forward from the current item', () => {
    const labels = ['codex', 'claude', 'qoder', 'pi']
    expect(nextMenuIndex('ArrowDown', -1, labels)).toBe(0)
    expect(nextMenuIndex('ArrowDown', 3, labels)).toBe(0)
    expect(nextMenuIndex('ArrowUp', -1, labels)).toBe(3)
    expect(nextMenuIndex('ArrowUp', 0, labels)).toBe(3)
    expect(nextMenuIndex('Home', 2, labels)).toBe(0)
    expect(nextMenuIndex('End', 0, labels)).toBe(3)
    // Typeahead cycles through items sharing a first letter, starting after the current one.
    expect(nextMenuIndex('c', -1, labels)).toBe(0)
    expect(nextMenuIndex('c', 0, labels)).toBe(1)
    expect(nextMenuIndex('c', 1, labels)).toBe(0)
    expect(nextMenuIndex('z', 0, labels)).toBe(-1)
    // Space, Enter and Tab are not navigation keys.
    expect(nextMenuIndex(' ', 0, labels)).toBe(-1)
    expect(nextMenuIndex('Enter', 0, labels)).toBe(-1)
    expect(nextMenuIndex('Tab', 0, labels)).toBe(-1)
    expect(nextMenuIndex('ArrowDown', -1, [])).toBe(-1)
  })

  describe('menuKeyDown', () => {
    afterEach(() => { delete (globalThis as { document?: unknown }).document })

    const fakeMenu = (labels: string[]) => {
      const state: { active: unknown } = { active: null }
      const items = labels.map((label) => ({
        label,
        focus: vi.fn(function (this: unknown) { state.active = this }),
        textContent: label,
        getAttribute: (name: string) => (name === 'aria-label' ? null : null)
      }))
      Object.assign(globalThis, { document: { get activeElement() { return state.active } } })
      const selectors: string[] = []
      const menu = { querySelectorAll: (selector: string) => { selectors.push(selector); return items } }
      return { items, menu, selectors, focus: (index: number) => { state.active = items[index] } }
    }

    it('focuses the target item, prevents the default and reports the key as handled', () => {
      const { items, menu, selectors, focus } = fakeMenu(['打开', '重命名', 'Remove'])
      focus(0)
      const event = { key: 'ArrowDown', preventDefault: vi.fn() }
      expect(menuKeyDown(event, menu)).toBe(true)
      expect(items[1].focus).toHaveBeenCalled()
      expect(event.preventDefault).toHaveBeenCalled()
      // Only enabled menu items take part; separators, labels and other buttons do not.
      expect(selectors[0]).toContain('[role="menuitem"]:not(:disabled):not([aria-disabled="true"])')
      expect(selectors[0]).not.toMatch(/(^|,)button/)
      expect(menuKeyDown({ key: 'r', preventDefault: vi.fn() }, menu)).toBe(true)
      expect(items[2].focus).toHaveBeenCalled()
    })

    it('leaves modified keys and other keys to the caller', () => {
      const { items, menu } = fakeMenu(['a', 'b'])
      const ctrl = { key: 'ArrowDown', ctrlKey: true, preventDefault: vi.fn() }
      expect(menuKeyDown(ctrl, menu)).toBe(false)
      expect(menuKeyDown({ key: 'Escape', preventDefault: vi.fn() }, menu)).toBe(false)
      expect(ctrl.preventDefault).not.toHaveBeenCalled()
      expect(items[0].focus).not.toHaveBeenCalled()
    })
  })
})

describe('menu convergence guards', () => {
  it('defines menu surfaces and items only in styles-menus.css', () => {
    const offenders = files(rendererRoot, (name) => name.endsWith('.css') && name !== 'styles-menus.css')
      .flatMap((path) => Array.from(readFileSync(path, 'utf8').matchAll(/^\s*(\.menu-surface|\.mitem|button\.mitem|\.mdiv|\.mhdr|\.menu-check|\.ctxitem|\.surface-menu \.menu-item)\s*[,{:]/gm),
        (match) => `${relative(rendererRoot, path)}: ${match[1]}`))
    expect(offenders).toEqual([])
  })

  it('uses the Menu primitive for every command menu', () => {
    // Not command menus (DESIGN.md): the diff scope menu's virtualized turn submenu and the
    // workspace picker's searchable list both move focus with aria-activedescendant.
    const handWritten = files(rendererRoot, (name) => name.endsWith('.tsx') && !name.includes('.test.'))
      .filter((path) => !/primitives\/Menu\.tsx$|DiffScopeMenu\.tsx$|WorkspacePicker\.tsx$/.test(path) && !/render-tests|fixtures/.test(path))
      .filter((path) => /role="menu"/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(rendererRoot, path))
    expect(handWritten).toEqual([])
  })
})
