import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Real temporary files, production snapshot IPC and native keyboard scrolling; no injected diff data.
export async function exerciseWorkspaceDiffBounds({ target, targetSessionKey, click, evaluate, key, wait, screenshot, cdp }) {
  const newTargetDraft = async () => {
    // Managed worktrees stay under their source project, not a separate
    // project row. Reopen the actual session, then make a draft in its cwd.
    await click(`[data-motion-key=${JSON.stringify(targetSessionKey)}] .sb-sess`)
    await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'selected worktree session')
    await click('.sb-new')
    await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)} && document.querySelector('.workspace-context-strip button')?.disabled === false && document.querySelector('textarea')?.value === ''`), 'draft in selected worktree')
  }
  for (let index = 0; index < 1000; index++) {
    const text = index === 0
      ? Array.from({ length: 2000 }, (_, line) => `pressure-line-${String(line).padStart(4, '0')}\n`).join('') : 'one\n'
    writeFileSync(join(target, `pressure-${String(index).padStart(4, '0')}.txt`), text)
  }
  await newTargetDraft()
  await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'pressure workspace selected')
  const open = async () => {
    if (!await evaluate(`Boolean(document.querySelector('button.pinned-summary-row'))`)) await click('[data-pinned-summary-toggle]')
    await click('button.pinned-summary-row', 'Changes')
    await wait(() => evaluate(`document.querySelector('.diff-virtual-files [role="option"]')?.getAttribute('aria-setsize') === '1000'`), '1000-file captured snapshot')
    assert.ok(await evaluate(`document.querySelectorAll('.diff-virtual-files [role="option"]').length < 80`))
    assert.ok(await evaluate(`document.querySelectorAll('.diff-virtual-code [role="row"]').length > 0 && document.querySelectorAll('.diff-virtual-code [role="row"]').length < 100`))
  }
  await open()
  await click('.diff-stack-file button')
  await wait(() => evaluate(`document.querySelector('.diff-stack-file button')?.getAttribute('aria-expanded') === 'false'`), 'collapse first stacked file')
  await click('.diff-stack-file button')
  await wait(() => evaluate(`document.querySelector('.diff-stack-file button')?.getAttribute('aria-expanded') === 'true'`), 'reopen first stacked file')
  await key('End', 'End', 35)
  await wait(() => evaluate(`document.querySelector('.diff-virtual-code')?.textContent.includes('pressure-0999.txt')`), 'native End reaches the final stacked file')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.diff-virtual-code')`), true)
  await key('Home', 'Home', 36)
  try {
    await wait(() => evaluate(`document.querySelector('.diff-virtual-code')?.scrollTop === 0`), 'native Home has reached the start before the wheel gesture')
  } catch (error) {
    console.error('diff stress Home state:', await evaluate(`({ top: document.querySelector('.diff-virtual-code')?.scrollTop, active: document.activeElement?.outerHTML.slice(0, 350), rootHeight: document.querySelector('.diff-virtual-code')?.clientHeight })`))
    throw error
  }
  const scroll = await evaluate(`(() => {
    const panel = document.querySelector('.diff-virtual-code'), box = panel.getBoundingClientRect()
    const row = panel.querySelector('[role="row"]')
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, deltaY: 1990 * row.getBoundingClientRect().height }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', deltaX: 0, ...scroll })
  await wait(() => evaluate(`document.querySelector('.diff-virtual-code')?.textContent.includes('pressure-line-1999')`), 'native scroll reveals the end of a large file inside the stack')
  await click('.diff-virtual-files')
  await key('End', 'End', 35)
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files [aria-selected="true"]')?.getAttribute('aria-posinset') === '1000'`), 'native keyboard selects last virtual file')
  assert.ok(await evaluate(`document.querySelectorAll('.diff-virtual-files [role="option"]').length < 80`))
  await screenshot('inspector-pressure-dark')

  // Exercise the real persisted preference through a renderer restart, not a CSS-only class override.
  await evaluate(`localStorage.setItem('scry.theme', 'light')`)
  await cdp.send('Page.reload')
  await wait(() => evaluate(`document.documentElement?.dataset.theme === 'light' && Boolean(document.querySelector('[data-pinned-summary-toggle]'))`), 'light preference after reload')
  await newTargetDraft()
  await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'pressure workspace restored')
  await open()
  await screenshot('inspector-pressure-light')
  await click('.diff-scope-trigger')
  await screenshot('diff-scope-light')
  await key('Escape', 'Escape', 27)
}
