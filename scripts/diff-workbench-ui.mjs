import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const contextFixture = (changed = false, dirty = false) => Array.from({ length: 60 }, (_, index) =>
  `export const context${String(index).padStart(2, '0')} = '${index === 20 && changed ? 'committed-context-change' : index === 30 && dirty ? 'DIRTY-MUST-NOT-ENTER-COMMIT' : `baseline-${String(index).padStart(2, '0')}`}'\n`).join('')

/** Same production App, real immutable Git data and native pointer/keyboard events. */
export async function exerciseDiffWorkbench({ target, git, click, wait, evaluate, screenshot, cdp }) {
  const path = join(target, 'workbench-context.ts')
  writeFileSync(path, contextFixture(true))
  git(target, 'add', '--', 'workbench-context.ts')
  git(target, 'commit', '-m', 'review context fixture')
  const commit = git(target, 'rev-parse', 'HEAD')
  writeFileSync(path, contextFixture(true, true))
  await click('.diff-inspector-actions button[aria-label="刷新工作区差异"]')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files')?.textContent.includes('workbench-context.ts')`), 'new captured branch range')
  assert.equal(await evaluate(`document.querySelectorAll('.diff-virtual-files [role="option"]').length`), 3)
  await click('.diff-navigation-tabs button', 'Commits')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-commits')?.textContent.includes('review context fixture')`), 'real branch commit list')
  await click('.diff-virtual-commits button', 'review context fixture')
  await wait(() => evaluate(`document.querySelector('.diff-commit-range')?.textContent.includes(${JSON.stringify(commit.slice(0, 8))}) &&
    document.querySelector('.diff-virtual-code')?.textContent.includes('committed-context-change')`), 'selected immutable commit patch')
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-code').textContent.includes('DIRTY-MUST-NOT-ENTER-COMMIT')`), false)
  await click('.diff-navigation-tabs button', 'Files')
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-files [role="option"]')?.getAttribute('aria-setsize')`), '1')
  const geometry = await evaluate(`(() => {
    const nav = document.querySelector('.diff-navigation'), code = document.querySelector('.diff-review-content')
    return { navRight: nav.getBoundingClientRect().right, codeLeft: code.getBoundingClientRect().left,
      font: parseFloat(getComputedStyle(document.querySelector('.diff-code-row code')).fontSize),
      headerHeight: document.querySelector('.diff-stack-file button').getBoundingClientRect().height,
      rowHeight: document.querySelector('.diff-code-row').getBoundingClientRect().height }
  })()`)
  assert.ok(geometry.navRight <= geometry.codeLeft + 1, JSON.stringify(geometry))
  assert.ok(geometry.font <= 12, JSON.stringify(geometry))
  assert.equal(geometry.rowHeight, 24)
  assert.ok(geometry.headerHeight >= 24, JSON.stringify(geometry))
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-code').textContent.includes('baseline-08')`), false)
  await click('.diff-context-gap button')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-code').textContent.includes('baseline-08')`), 'expand actual captured context')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.diff-virtual-code')`), true)
  await click('.diff-code-toolbar button', '收起上下文')
  await wait(() => evaluate(`!document.querySelector('.diff-virtual-code').textContent.includes('baseline-08')`), 'collapse captured context')
  await click('.diff-layout-switch button', 'Split')
  await wait(() => evaluate(`Boolean(document.querySelector('.diff-split-cell.diff-del code')) && Boolean(document.querySelector('.diff-split-cell.diff-add code'))`), 'split replacement rows')
  const pair = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.diff-split-row')].find(node => node.textContent.includes('committed-context-change'))
    return [...row.querySelectorAll('.diff-split-cell')].map(cell => ({ number: cell.querySelector('.diff-line-no').textContent, text: cell.querySelector('code').textContent }))
  })()`)
  assert.equal(pair[0].number, '21')
  assert.equal(pair[1].number, '21')
  assert.ok(pair[0].text.includes('baseline-20'))
  assert.ok(pair[1].text.includes('committed-context-change'))
  const splitGeometry = await evaluate(`(() => {
    const pane = document.querySelector('.diff-virtual-code').getBoundingClientRect()
    const cells = [...document.querySelectorAll('.diff-split-row')].find(row => row.textContent.includes('committed-context-change')).querySelectorAll('.diff-split-cell')
    return { left: pane.left, right: pane.right, cells: [...cells].map(cell => ({ left: cell.getBoundingClientRect().left, right: cell.getBoundingClientRect().right })) }
  })()`)
  assert.ok(splitGeometry.cells.every(cell => cell.left >= splitGeometry.left - 1 && cell.right <= splitGeometry.right + 1), JSON.stringify(splitGeometry))
  const splitScrollPoint = await evaluate(`(() => { const box = document.querySelector('.diff-virtual-code').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + 80 } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...splitScrollPoint, deltaX: 160, deltaY: 0 })
  await wait(() => evaluate(`document.querySelector('.diff-virtual-code').scrollLeft > 100`), 'shared horizontal split scroll')
  const scrolled = await evaluate(`(() => {
    const pane = document.querySelector('.diff-virtual-code')
    const cells = [...document.querySelectorAll('.diff-split-row')].find(row => row.textContent.includes('committed-context-change')).querySelectorAll('.diff-split-cell')
    return { offset: pane.scrollLeft, cells: [...cells].map(cell => ({ left: cell.getBoundingClientRect().left,
      shift: new DOMMatrixReadOnly(getComputedStyle(cell.querySelector('code > span')).transform).m41 })) }
  })()`)
  for (let index = 0; index < 2; index++) {
    assert.ok(Math.abs(scrolled.cells[index].left - splitGeometry.cells[index].left) < 1, JSON.stringify(scrolled))
    assert.ok(Math.abs(scrolled.cells[index].shift + scrolled.offset) < 1, JSON.stringify(scrolled))
  }
  await screenshot('diff-workbench-split')
  await click('.diff-layout-switch button', 'Unified')

  await click('.diff-navigation-tabs button', 'Commits')
  await click('.diff-virtual-commits button', 'separate workspace from session baseline')
  await wait(() => evaluate(`document.querySelector('.diff-review-prompt')?.textContent === 'separate workspace from session baseline'`), 'older immutable commit selected')
  await click('.diff-navigation-tabs button', 'Files')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files')?.textContent.includes('remote-first.txt')`), 'older commit file list')
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('workbench-context.ts')`), false)
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-code').textContent.includes('DIRTY-MUST-NOT-ENTER-COMMIT')`), false)
  await click('.diff-all-changes')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files [role="option"]')?.getAttribute('aria-setsize') === '3'`), 'all branch changes restored')
  await click('.diff-virtual-files [role="option"]', 'workbench-context.ts')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-code')?.textContent.includes('DIRTY-MUST-NOT-ENTER-COMMIT')`), 'branch view includes live edits from its captured snapshot')

  const before = await evaluate(`document.querySelector('#right-surface-pane').getBoundingClientRect().width`)
  const point = await evaluate(`(() => { const box = document.querySelector('.panel-resizer[aria-controls="right-surface-pane"]').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x - 100, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x - 100, y: point.y })
  await wait(() => evaluate(`document.querySelector('#right-surface-pane').getBoundingClientRect().width > ${before + 50}`), 'native sidebar resize')
  await click('[data-session-surface-current="true"] button[aria-label="最大化右侧工作区"]')
  await wait(() => evaluate(`document.querySelector('[data-session-surface-current="true"] .right-surface-panel[data-maximized="true"]') != null`), 'maximize review')
  await screenshot('diff-workbench-maximized')
  await click('[data-session-surface-current="true"] button[aria-label="恢复右侧工作区"]')
  await wait(() => evaluate(`document.querySelector('[data-session-surface-current="true"] .right-surface-panel[data-maximized="true"]') == null`), 'restore sidebar')
  await click('.diff-inspector-actions button[aria-label="关闭改动面板"]')
  await wait(() => evaluate(`!document.querySelector('.diff-inspector')`), 'close Diff')
  await click('[data-session-surface-current="true"] button[aria-label="添加 Surface"]')
  await click('.surface-menu .menu-item', 'Diff')
  await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffScope === 'branch' && Boolean(document.querySelector('.diff-virtual-files'))`), 'reopen through existing right-side entry')
  await wait(() => evaluate(`!document.querySelector('.diff-refresh-state')`), 'settled reopened snapshot')
  await screenshot('diff-workbench-sidebar')
  writeFileSync(path, contextFixture(true))
  await click('.diff-inspector-actions button[aria-label="刷新工作区差异"]')
  await wait(() => evaluate(`!document.querySelector('.diff-refresh-state')`), 'restore clean working file')
  console.log(JSON.stringify({ test: 'real diff workbench', commit, geometry, immutableHistory: true, splitLineNumbers: pair.map(item => item.number), contextFromCapturedPatch: true, sidebarResize: true }))
}
