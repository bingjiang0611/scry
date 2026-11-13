import assert from 'node:assert/strict'
import { pierreDiffEval, pierreDiffHasText, pierreDiffLinesForText, pierreTreeAttribute, pierreTreeHasText } from './pierre-ui.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const contextFixture = (changed = false, dirty = false) => Array.from({ length: 60 }, (_, index) =>
  `export const context${String(index).padStart(2, '0')} = '${index === 20 && changed ? 'committed-context-change' : index === 30 && dirty ? 'DIRTY-MUST-NOT-ENTER-COMMIT' : `baseline-${String(index).padStart(2, '0')}`}'\n`).join('')

/** Same production App, real immutable Git data and native pointer/keyboard events. */
export async function exerciseDiffWorkbench({ target, git, click, wait, evaluate, screenshot, cdp }) {
  // The pane motion assertions measure the normal path; CI runners report
  // `prefers-reduced-motion: reduce`, where a stationary pane deliberately does not
  // animate. Pin the media feature instead of inheriting the host setting. The reduced
  // path is covered by src/renderer/pane-motion.test.ts.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), false,
    'pane motion must be measured with motion enabled')
  const path = join(target, 'workbench-context.ts')
  writeFileSync(path, contextFixture(true))
  git(target, 'add', '--', 'workbench-context.ts')
  git(target, 'commit', '-m', 'review context fixture')
  const commit = git(target, 'rev-parse', 'HEAD')
  writeFileSync(path, contextFixture(true, true))
  await click('.diff-inspector-actions button[aria-label="刷新工作区差异"]')
  await wait(() => evaluate(pierreTreeHasText('workbench-context.ts')), 'new captured branch range')
  assert.equal(await evaluate(pierreTreeAttribute('[role="treeitem"]', 'aria-setsize')), '3')
  await click('.diff-navigation-tabs button', 'Commits')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-commits')?.textContent.includes('review context fixture')`), 'real branch commit list')
  await click('.diff-virtual-commits button', 'review context fixture')
  await wait(() => evaluate(`document.querySelector('.diff-commit-range')?.textContent.includes(${JSON.stringify(commit.slice(0, 8))}) &&
    ${pierreDiffHasText('committed-context-change')}`), 'selected immutable commit patch')
  assert.equal(await evaluate(pierreDiffHasText('DIRTY-MUST-NOT-ENTER-COMMIT')), false)
  await click('.diff-navigation-tabs button', 'Files')
  assert.equal(await evaluate(pierreTreeAttribute('[role="treeitem"]', 'aria-setsize')), '1')
  const geometry = await evaluate(pierreDiffEval(`(() => {
    const nav = document.querySelector('.diff-navigation'), code = document.querySelector('.diff-review-content')
    const line = roots.flatMap(root => [...root.querySelectorAll('[data-line]')])[0]
    return { navRight: nav.getBoundingClientRect().right, codeLeft: code.getBoundingClientRect().left,
      font: parseFloat(getComputedStyle(line).fontSize),
      headerHeight: document.querySelector('.pierre-file-header > button').getBoundingClientRect().height,
      rowHeight: line.getBoundingClientRect().height }
  })()`))
  assert.ok(geometry.navRight <= geometry.codeLeft + 1, JSON.stringify(geometry))
  assert.ok(geometry.font <= 12, JSON.stringify(geometry))
  assert.equal(geometry.rowHeight, 24)
  assert.ok(geometry.headerHeight >= 24, JSON.stringify(geometry))
  assert.equal(await evaluate(pierreDiffHasText('baseline-08')), false)
  await click('.pierre-file-header [data-expand-context]')
  await wait(() => evaluate(pierreDiffHasText('baseline-08')), 'expand actual captured context')
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.pierre-code-view')`), true)
  await click('.diff-code-toolbar button', '收起上下文')
  await wait(() => evaluate(`!(${pierreDiffHasText('baseline-08')})`), 'collapse captured context')
  await click('.diff-layout-switch button', 'Split')
  await wait(() => evaluate(pierreDiffEval(`roots.some(root => root.querySelector('pre[data-diff-type="split"] [data-line]'))`)), 'split replacement rows')
  const pair = await evaluate(pierreDiffLinesForText(['baseline-20', 'committed-context-change']))
  assert.equal(pair[0].number, '21')
  assert.equal(pair[1].number, '21')
  assert.ok(pair[0].text.includes('baseline-20'))
  assert.ok(pair[1].text.includes('committed-context-change'))
  const splitGeometry = await evaluate(pierreDiffEval(`(() => {
    const pane = document.querySelector('.pierre-code-view').getBoundingClientRect()
    const cells = roots.flatMap(root => [...root.querySelectorAll('[data-line]')]).filter(line => line.textContent.includes('baseline-20') || line.textContent.includes('committed-context-change'))
    return { left: pane.left, right: pane.right, lineLefts: cells.map(cell => cell.getBoundingClientRect().left),
      cells: cells.map(cell => { const box = cell.closest('[data-code]').getBoundingClientRect(); return { left: box.left, right: box.right } }) }
  })()`))
  assert.ok(splitGeometry.cells.every(cell => cell.left >= splitGeometry.left - 1 && cell.right <= splitGeometry.right + 1), JSON.stringify(splitGeometry))
  // CodeView briefly suspends body pointer events while a layout scroll settles.
  await wait(() => evaluate(pierreDiffEval(`roots.some(root => {
    const code = root.querySelector('code[data-deletions]')
    return code && getComputedStyle(code).pointerEvents === 'auto'
  })`)), 'split body accepts native wheel input')
  const splitScrollPoint = await evaluate(pierreDiffEval(`(() => {
    const code = roots.flatMap(root => [...root.querySelectorAll('code[data-deletions]')])[0]
    const box = code.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + 40 }
  })()`))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...splitScrollPoint, deltaX: 160, deltaY: 0 })
  try {
    await wait(() => evaluate(pierreDiffEval(`roots.some(root => {
      const left = root.querySelector('code[data-deletions]'), right = root.querySelector('code[data-additions]')
      return left?.scrollLeft > 100 && Math.abs(left.scrollLeft - right?.scrollLeft) < 1
    })`)), 'shared horizontal split scroll')
  } catch (error) {
    console.error('split scroll evidence:', splitScrollPoint, await evaluate(pierreDiffEval(`roots.flatMap(root => [...root.querySelectorAll('code[data-code]')]).map(code => ({
      type: code.hasAttribute('data-deletions') ? 'left' : 'right', offset: code.scrollLeft, width: code.clientWidth, fullWidth: code.scrollWidth,
      overflow: getComputedStyle(code).overflowX, box: code.getBoundingClientRect().toJSON()
    }))`)))
    throw error
  }
  const scrolled = await evaluate(pierreDiffEval(`(() => {
    const cells = roots.flatMap(root => [...root.querySelectorAll('[data-line]')]).filter(line => line.textContent.includes('baseline-20') || line.textContent.includes('committed-context-change'))
    return { cells: cells.map(cell => ({ left: cell.getBoundingClientRect().left, offset: cell.closest('[data-code]').scrollLeft })) }
  })()`))
  for (let index = 0; index < 2; index++) {
    assert.ok(scrolled.cells[index].offset > 100 && Math.abs(scrolled.cells[index].left - splitGeometry.lineLefts[index] + scrolled.cells[index].offset) < 1, JSON.stringify(scrolled))
  }
  await screenshot('diff-workbench-split')
  await click('.diff-layout-switch button', 'Unified')

  await click('.diff-navigation-tabs button', 'Commits')
  await click('.diff-virtual-commits button', 'separate workspace from session baseline')
  await wait(() => evaluate(`document.querySelector('.diff-review-prompt')?.textContent === 'separate workspace from session baseline'`), 'older immutable commit selected')
  await click('.diff-navigation-tabs button', 'Files')
  await wait(() => evaluate(pierreTreeHasText('remote-first.txt')), 'older commit file list')
  assert.equal(await evaluate(pierreTreeHasText('workbench-context.ts')), false)
  assert.equal(await evaluate(pierreDiffHasText('DIRTY-MUST-NOT-ENTER-COMMIT')), false)
  await click('.diff-all-changes')
  await wait(() => evaluate(`(${pierreTreeAttribute('[role="treeitem"]', 'aria-setsize')}) === '3'`), 'all branch changes restored')
  await click('[data-item-path]', 'workbench-context.ts')
  await wait(() => evaluate(pierreDiffHasText('DIRTY-MUST-NOT-ENTER-COMMIT')), 'branch view includes live edits from its captured snapshot')

  // Record the pane animations the App actually creates: the 250ms window is too
  // short to sample `getAnimations()` after a pointer round trip, and a loaded
  // runner would read an empty list for reasons unrelated to the fix.
  await evaluate(`(() => {
    window.__paneMotions = []
    const original = Element.prototype.animate
    window.__restorePaneAnimate = () => { Element.prototype.animate = original }
    Element.prototype.animate = function (keyframes, options) {
      if (/^(sidebar-pane|right-surface-pane|remote-right-surface-pane)$/.test(this.id ?? '')) {
        window.__paneMotions.push({ pane: this.id, frames: Array.isArray(keyframes) ? keyframes : null })
      }
      return original.call(this, keyframes, options)
    }
  })()`)
  const before = await evaluate(`document.querySelector('#right-surface-pane').getBoundingClientRect().width`)
  const point = await evaluate(`(() => { const box = document.querySelector('.panel-resizer[aria-controls="right-surface-pane"]').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 } })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: point.x - 100, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x - 100, y: point.y })
  await wait(() => evaluate(`document.querySelector('#right-surface-pane').getBoundingClientRect().width > ${before + 50}`), 'native sidebar resize')
  await click('[data-session-surface-current="true"] button[aria-label="最大化右侧工作区"]')
  // Both panes stay on screen when the workbench maximizes, so they must shift without
  // fading: a whole-pane opacity ramp reads as a crossfade of the transcript.
  const paneFrames = await evaluate(`(async () => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && (window.__paneMotions ?? []).length === 0) {
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    const recorded = (window.__paneMotions ?? []).slice()
    window.__restorePaneAnimate()
    return recorded
  })()`)
  assert.ok(paneFrames.length > 0, 'maximize did not animate the panes')
  assert.deepEqual(paneFrames.filter(entry => entry.frames.some(frame => 'opacity' in frame)).map(entry => entry.pane), [],
    'a pane that stays on screen faded instead of shifting')
  await wait(() => evaluate(`document.querySelector('[data-session-surface-current="true"] .right-surface-panel[data-maximized="true"]') != null`), 'maximize review')
  await screenshot('diff-workbench-maximized')
  await click('[data-session-surface-current="true"] button[aria-label="恢复右侧工作区"]')
  await wait(() => evaluate(`document.querySelector('[data-session-surface-current="true"] .right-surface-panel[data-maximized="true"]') == null`), 'restore sidebar')
  await click('.diff-inspector-actions button[aria-label="关闭改动面板"]')
  await wait(() => evaluate(`!document.querySelector('.diff-inspector')`), 'close Diff')
  await click('[data-session-surface-current="true"] button[aria-label="添加 Surface"]')
  await click('.surface-menu .menu-item', 'Diff')
  await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffScope === 'branch' && Boolean(document.querySelector('file-tree-container')?.shadowRoot)`), 'reopen through existing right-side entry')
  await wait(() => evaluate(`!document.querySelector('.diff-refresh-state')`), 'settled reopened snapshot')
  await screenshot('diff-workbench-sidebar')
  writeFileSync(path, contextFixture(true))
  await click('.diff-inspector-actions button[aria-label="刷新工作区差异"]')
  await wait(() => evaluate(`!document.querySelector('.diff-refresh-state')`), 'restore clean working file')
  console.log(JSON.stringify({ test: 'real diff workbench', commit, geometry, immutableHistory: true, splitLineNumbers: pair.map(item => item.number), contextFromCapturedPatch: true, sidebarResize: true }))
}
