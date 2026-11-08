import assert from 'node:assert/strict'
import { pierreDiffEval, pierreDiffHasText, pierreDiffLineCount, pierreTreeAttribute, pierreTreeVisibleCount } from './pierre-ui.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Real temporary files, production snapshot IPC and native keyboard scrolling; no injected diff data.
// openWorkspace(cwd) must reach the real workspace whose execution cwd is cwd: the project draft for a
// project root, the nested session for a managed worktree (a worktree is never a project group).
export async function exerciseWorkspaceDiffBounds({ target, openWorkspace, click, evaluate, key, wait, screenshot, cdp }) {
  for (let index = 0; index < 1000; index++) {
    const text = index === 0
      ? Array.from({ length: 2000 }, (_, line) => `pressure-line-${String(line).padStart(4, '0')}\n`).join('') : 'one\n'
    writeFileSync(join(target, `pressure-${String(index).padStart(4, '0')}.txt`), text)
  }
  await openWorkspace(target)
  await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'pressure workspace selected')
  const open = async () => {
    if (!await evaluate(`Boolean(document.querySelector('button.pinned-summary-row'))`)) await click('[data-pinned-summary-toggle]')
    await click('button.pinned-summary-row', 'Changes')
    await wait(() => evaluate(`(${pierreTreeAttribute('[role="treeitem"]', 'aria-setsize')}) === '1000'`), '1000-file captured snapshot')
    assert.ok(await evaluate(`(${pierreTreeVisibleCount()}) < 80`))
    await wait(() => evaluate(`(${pierreDiffLineCount()}) > 0`), 'first captured diff rows mounted')
    const lineCount = await evaluate(pierreDiffLineCount())
    assert.ok(lineCount < 100, `Unbounded stacked diff DOM: ${lineCount} rendered rows`)
  }
  await open()
  await click('.pierre-file-header > button')
  await wait(() => evaluate(`document.querySelector('.pierre-file-header > button')?.getAttribute('aria-expanded') === 'false'`), 'collapse first stacked file')
  await click('.pierre-file-header > button')
  await wait(() => evaluate(`document.querySelector('.pierre-file-header > button')?.getAttribute('aria-expanded') === 'true'`), 'reopen first stacked file')
  await key('End', 'End', 35)
  await wait(() => evaluate(`[...document.querySelectorAll('.pierre-file-header')].some(header => header.textContent.includes('pressure-0999.txt'))`), 'native End reaches the final stacked file')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.pierre-code-view')`), true)
  await key('Home', 'Home', 36)
  try {
    await wait(() => evaluate(`document.querySelector('.pierre-code-view')?.scrollTop === 0`), 'native Home has reached the start before the wheel gesture')
  } catch (error) {
    console.error('diff stress Home state:', await evaluate(`({ top: document.querySelector('.pierre-code-view')?.scrollTop, active: document.activeElement?.outerHTML.slice(0, 350), rootHeight: document.querySelector('.pierre-code-view')?.clientHeight })`))
    throw error
  }
  const scroll = await evaluate(pierreDiffEval(`(() => {
    const panel = document.querySelector('.pierre-code-view'), box = panel.getBoundingClientRect()
    const row = roots.flatMap(root => [...root.querySelectorAll('[data-line]')])[0]
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, deltaY: 1990 * row.getBoundingClientRect().height }
  })()`))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, ...scroll })
  await wait(() => evaluate(pierreDiffHasText('pressure-line-1999')), 'native scroll reveals the end of a large file inside the stack')
  await click('[role="treeitem"]', 'pressure-0000.txt')
  await key('End', 'End', 35)
  await wait(() => evaluate(`(${pierreTreeAttribute('[aria-selected="true"]', 'aria-posinset')}) === '1000'`), 'native keyboard selects last virtual file')
  assert.ok(await evaluate(`(${pierreTreeVisibleCount()}) < 80`))
  await screenshot('inspector-pressure-dark')

  // Exercise the real persisted preference through a renderer restart, not a CSS-only class override.
  await evaluate(`localStorage.setItem('scry.theme', 'light')`)
  await cdp.send('Page.reload')
  await wait(() => evaluate(`document.documentElement?.dataset.theme === 'light' && Boolean(document.querySelector('[data-pinned-summary-toggle]'))`), 'light preference after reload')
  await openWorkspace(target)
  await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'pressure workspace restored')
  await open()
  await screenshot('inspector-pressure-light')
  await click('.diff-scope-trigger')
  await screenshot('diff-scope-light')
  await key('Escape', 'Escape', 27)
}
