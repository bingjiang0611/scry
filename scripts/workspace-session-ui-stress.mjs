import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Real temporary files, production snapshot IPC and native keyboard scrolling; no injected diff data.
export async function exerciseWorkspaceDiffBounds({ target, newDraft, click, evaluate, key, wait, screenshot, cdp }) {
  for (let index = 0; index < 1000; index++) {
    const text = index === 0
      ? Array.from({ length: 2000 }, (_, line) => `pressure-line-${String(line).padStart(4, '0')}\n`).join('') : 'one\n'
    writeFileSync(join(target, `pressure-${String(index).padStart(4, '0')}.txt`), text)
  }
  await newDraft(target)
  await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'pressure workspace selected')
  const open = async () => {
    if (!await evaluate(`Boolean(document.querySelector('button.pinned-summary-row'))`)) await click('[data-pinned-summary-toggle]')
    await click('button.pinned-summary-row', 'Changes')
    await wait(() => evaluate(`document.querySelector('.diff-virtual-files [role="option"]')?.getAttribute('aria-setsize') === '1000'`), '1000-file captured snapshot')
    assert.ok(await evaluate(`document.querySelectorAll('.diff-virtual-files [role="option"]').length < 80`))
    assert.ok(await evaluate(`document.querySelectorAll('.diff-virtual-code [role="row"]').length < 100`))
  }
  await open()
  await click('.diff-virtual-code')
  await key('End', 'End', 35)
  await wait(() => evaluate(`document.querySelector('.diff-virtual-code')?.textContent.includes('pressure-line-1999')`), 'native scroll reveals last patch line')
  await click('.diff-virtual-files')
  await key('End', 'End', 35)
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files [aria-selected="true"]')?.getAttribute('aria-posinset') === '1000'`), 'native keyboard selects last virtual file')
  assert.ok(await evaluate(`document.querySelectorAll('.diff-virtual-files [role="option"]').length < 80`))
  await screenshot('inspector-pressure-dark')

  // Exercise the real persisted preference through a renderer restart, not a CSS-only class override.
  await evaluate(`localStorage.setItem('scry.theme', 'light')`)
  await cdp.send('Page.reload')
  await wait(() => evaluate(`document.documentElement?.dataset.theme === 'light' && Boolean(document.querySelector('[data-pinned-summary-toggle]'))`), 'light preference after reload')
  await newDraft(target)
  await wait(() => evaluate(`document.querySelector('.tb-thread')?.title === ${JSON.stringify(target)}`), 'pressure workspace restored')
  await open()
  await screenshot('inspector-pressure-light')
}
