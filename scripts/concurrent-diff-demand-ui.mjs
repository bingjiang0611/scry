import assert from 'node:assert/strict'

/** Functional real-App acceptance only; its diagnostic reads are not a latency benchmark. */
export async function exerciseConcurrentDiffDemand({ evaluate, activate, wait, conversations, cdp, mode }) {
  if (!['1', 'narrow-files', 'maximized-overview'].includes(mode)) return undefined
  if (mode === '1') mode = 'switch'
  assert.ok(conversations.length >= 2, 'Demand acceptance requires at least two actual conversations')
  const runId = await evaluate('window.__concurrentStarts[0].runId')
  const run = `(await window.scry.activeRuns()).find(run => run.runId === ${JSON.stringify(runId)})`
  const preview = `(${run})?.items.findLast(event => event.stage === 'turn_diff_preview')?.turnDiff`
  await wait(`(${preview})?.status === 'captured'`)
  const first = await evaluate(`(async () => (${preview}))()`)
  assert.ok(first.files.length > 0 && first.files.length <= 4, 'Initial view must attach early enough to cover a hidden preview interval')

  if (mode === 'switch') {
    await activate(`button[data-conversation-id="${conversations[1].id}"]`)
    await wait(`document.querySelector('main.unified-conversation[data-conversation-id="${conversations[1].id}"]')`)
  } else {
    await activate('#main-pane .topbar button[aria-label="右侧工作区"]')
    if (mode === 'narrow-files') {
      await activate('#right-surface-pane button[aria-label="添加 Surface"]')
      const menu = '#right-surface-pane .surface-menu button[role="menuitem"]'
      const index = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(menu)})).findIndex(node => node.querySelector('span')?.textContent === '文件')`)
      assert.ok(index >= 0, 'Native workbench menu must expose the Files surface')
      await activate(`${menu}:nth-of-type(${index + 1})`)
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false })
      await wait("document.querySelector('.app-shell')?.dataset.narrowPane === 'panel' && getComputedStyle(document.getElementById('main-pane')).display === 'none'")
    } else {
      await activate('#right-surface-pane button[aria-label="最大化右侧工作区"]')
      await wait("document.getElementById('main-pane')?.getAttribute('aria-hidden') === 'true'")
    }
  }
  // A workload milestone, not a sleep: the provider keeps writing through more
  // than the existing eight-second preview interval.
  await wait(`(${run})?.items.filter(event => event.kind === 'tool' && event.stage === 'tool_result').length >= 14`)
  const hidden = await evaluate(`(async () => ({ done: (${run})?.done, preview: (${preview}) }))()`)
  assert.equal(hidden.done, false, 'The run must still be active')
  if (mode === 'maximized-overview') {
    assert.ok(hidden.preview.afterAt > first.afterAt, 'Visible Overview lost its live preview when the transcript was maximized away')
    const initialPaths = new Set(first.files.map(file => file.path))
    const newFile = hidden.preview.files.find(file => !initialPaths.has(file.path))?.path.split('/').at(-1)
    assert.ok(newFile, 'Overview must receive a file absent from the initial preview')
    const visibleAt = await evaluate('Date.now()')
    await wait(`await (async () => {
      if (Date.now() - ${visibleAt} > 2000) throw new Error('Visible Overview did not render the new evidence within 2 seconds');
      return !(${run})?.done && document.querySelector('#right-surface-pane')?.textContent.includes(${JSON.stringify(newFile)});
    })()`)
    return { runId, mode, firstAfterAt: first.afterAt, visibleAfterAt: hidden.preview.afterAt,
      visibleFiles: hidden.preview.files.length, renderedNewFile: newFile, visibleOverviewKeptFresh: true, freshBeforeTerminal: true }
  }
  assert.equal(hidden.preview.afterAt, first.afterAt, 'Hidden view published a new background preview')

  const requestedAt = await evaluate('Date.now()')
  if (mode === 'narrow-files') {
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await wait("getComputedStyle(document.getElementById('main-pane')).display !== 'none'")
  } else {
    await activate(`button[data-conversation-id="${conversations[0].id}"]`)
  }
  await wait(`await (async () => {
    if (Date.now() - ${requestedAt} > 2000) throw new Error('Returning view did not receive a fresh preview within 2 seconds');
    const current = ${run};
    const snapshot = current?.items.findLast(event => event.stage === 'turn_diff_preview')?.turnDiff;
    return !current?.done && snapshot?.afterAt > ${JSON.stringify(first.afterAt)} && snapshot.files.length >= 14;
  })()`)
  const fresh = await evaluate(`(async () => (${preview}))()`)
  const fileLabel = JSON.stringify(fresh.files.length + ' files')
  await wait(`await (async () => {
    if (Date.now() - ${requestedAt} > 2000) throw new Error('Fresh preview did not reach the rendered view within 2 seconds');
    return document.querySelector('main.unified-conversation .files-summary.diff .fh-file-count')?.textContent === ${fileLabel};
  })()`)
  const renderedDiffFiles = await evaluate("document.querySelector('main.unified-conversation .files-summary.diff .fh-file-count')?.textContent")
  return { runId, mode, firstAfterAt: first.afterAt, hiddenAfterAt: hidden.preview.afterAt,
    returnedAfterAt: fresh.afterAt, firstFiles: first.files.length, returnedFiles: fresh.files.length, renderedDiffFiles,
    hiddenRunStillWorking: true, staleTimeNotRewritten: true, freshBeforeTerminal: true }
}
