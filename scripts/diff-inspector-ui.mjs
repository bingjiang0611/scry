import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function selectDiffScope({ click, wait, evaluate }, scope) {
  await click('.diff-scope-trigger')
  await wait(() => evaluate(`Boolean(document.querySelector('.diff-scope-menu'))`), 'compact diff scope menu')
  await click(`[data-diff-choice="${scope}"]`)
  await wait(() => evaluate(`!document.querySelector('.diff-scope-menu')`), 'scope selection closes the menu')
}

export async function exerciseTurnMenu({ click, key, wait, evaluate, screenshot, target, firstRunId, latestRunId }) {
  const actions = { click, wait, evaluate }
  await selectDiffScope(actions, 'latest')
  await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffRunId === ${JSON.stringify(latestRunId)}`), 'latest turn is the last actual run')
  await click('.diff-scope-trigger')
  const menu = await evaluate(`(() => { const rect = document.querySelector('.diff-scope-menu').getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, viewport: innerWidth,
      oldTabs: Boolean(document.querySelector('.diff-scope-tabs, .diff-turn-picker select')) } })()`)
  assert.ok(menu.width <= 240 && menu.left >= 0 && menu.right <= menu.viewport)
  assert.equal(menu.oldTabs, false)
  await screenshot('diff-scope-menu-dark')
  await key('Escape', 'Escape', 27)
  assert.equal(await evaluate(`document.activeElement?.classList.contains('diff-scope-trigger')`), true)
  await click('.diff-scope-trigger')
  await click('[data-diff-choice="turns"]')
  await wait(() => evaluate(`document.querySelectorAll('.diff-turn-choice').length === 2`), 'both recorded turns are selectable')
  const bounds = await evaluate(`(() => { const rect = document.querySelector('.diff-turn-menu').getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight } })()`)
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height)
  await screenshot('diff-turn-menu-dark')

  // Mutate today's file: a historical turn must still show its retained patch, not this content.
  const file = join(target, 'remote-first.txt')
  const original = readFileSync(file, 'utf8')
  const later = 'unrelated later workspace edit\n'
  writeFileSync(file, later)
  try {
    await key('End', 'End', 35)
    await key('Enter', 'Enter', 13)
    await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffRunId === ${JSON.stringify(firstRunId)} &&
      document.querySelector('.diff-virtual-files')?.textContent.includes('remote-first.txt')`), 'oldest turn selected with native keyboard')
    assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('remote-second.txt')`), false)
    const patch = await evaluate(`document.querySelector('.diff-virtual-code').textContent`)
    assert.ok(patch.includes(original.trim()))
    assert.equal(patch.includes(later.trim()), false, 'history never reads current file content as its old patch')
    assert.equal(await evaluate(`document.querySelector('.diff-scope-trigger').textContent.trim()`), '第 1 轮')
    await screenshot('diff-first-turn')
  } finally { writeFileSync(file, original) }
  await selectDiffScope(actions, 'latest')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files')?.textContent.includes('remote-second.txt')`), 'latest turn restored')
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('remote-first.txt')`), false)
  assert.equal(await evaluate(`document.querySelector('.diff-scope-trigger').textContent.trim()`), '最新一轮')
}
