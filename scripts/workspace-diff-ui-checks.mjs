export async function exerciseWorkspaceDiff(contents) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
    throw new Error(`Workspace diff condition timed out: ${expression}`)
  }
  const click = async (selector) => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Obscured diff control');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  await click('#overview-session-tab')
  const state = (status, text) => `['#diff-summary', '#diff-overview'].every(selector => {
    const node = document.querySelector(selector + ' [role="status"][data-evidence="${status}"]');
    return node && node.getBoundingClientRect().height > 0 && node.textContent.includes(${JSON.stringify(text)});
  })`
  await wait(state('captured', '无改动'))
  for (const [mode, status, text] of [
    ['dirty', 'captured', '+5'],
    ['unavailable', 'unavailable', '不可用'],
    ['timeout', 'timeout', '采集超时'],
    ['reject', 'failed', '采集失败']
  ]) {
    await click(`#diff-${mode}`)
    await wait(state(status, text))
    if (status !== 'captured' && await read(`document.querySelector('#diff-report').textContent.includes('**git diff**：无改动')`)) {
      throw new Error('Missing Git evidence was exported as a clean workspace')
    }
  }
  await click('#diff-dirty')
  await wait(state('captured', '+5'))
  await click('#diff-pending')
  await wait(state('refreshing', '+5'))
  await wait(`['#diff-summary', '#diff-overview'].every(selector => {
    const text = document.querySelector(selector).textContent;
    return text.includes('刷新中') && text.includes('来源');
  }) && document.querySelector('#diff-overview .gd-path')?.textContent === 'a.ts'`)
  // A later same-cwd reply wins even if the earlier request finishes last.
  await click('#diff-clean')
  await wait(state('captured', '无改动'))
  await click('#diff-release')
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (!(await read(state('captured', '无改动')))) throw new Error('Out-of-order same-workspace reply replaced the latest result')
  await click('#diff-pending')
  await wait(state('refreshing', '无改动'))
  await click('#diff-switch')
  await wait(state('captured', '无改动'))
  await click('#diff-release')
  // The rejected older context must not replace the second project's accepted result.
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (!(await read(state('captured', '无改动')))) throw new Error('Stale Git reply replaced the current workspace')
  await click('#diff-unbind')
  await wait(`!document.querySelector('#diff-summary [role="status"]') && !document.querySelector('#diff-overview [data-evidence]')`)
  const history = "(JSON.parse(document.querySelector('#history-state').textContent))"
  await click('#history-commits')
  await wait(`${history}.pageCalls === 1 && ${history}.pagePending`)
  await click('#history-scope')
  await wait(`!${history}.enabled`)
  await click('#history-scope')
  await wait(`${history}.enabled && ${history}.pageCalls === 2 && ${history}.pagePending`)
  await click('#history-old-page')
  await read('new Promise(resolve => requestAnimationFrame(resolve))')
  await wait(`${history}.pagePending && !${history}.pageFailed`)
  await click('#history-current-page')
  await wait(`!${history}.pagePending && ${history}.commits === 1`)
  await click('#history-select')
  await wait(`${history}.snapshotCalls === 1 && ${history}.snapshotPending`)
  await click('#history-scope')
  await wait(`!${history}.enabled`)
  await click('#history-scope')
  await wait(`${history}.pageCalls === 3 && !${history}.selected && !${history}.snapshotPending`)
  await click('#history-current-page')
  await wait(`!${history}.pagePending`)
  await click('#history-select')
  await wait(`${history}.snapshotCalls === 2 && ${history}.snapshotPending`)
  await click('#history-old-snapshot')
  await read('new Promise(resolve => requestAnimationFrame(resolve))')
  await wait(`${history}.snapshotPending && ${history}.collectedAt === null`)
  await click('#history-current-snapshot')
  await wait(`!${history}.snapshotPending && ${history}.collectedAt === '2026-10-25T00:00:00Z'`)
  await click('#diff-analytics')
  await wait(`document.querySelector('#integration-reads')?.dataset.analytics === '1'`)
  await click('#diff-data-updated')
  await wait(`document.querySelector('#integration-reads')?.dataset.analytics === '2'`)
  const reads = await read(`({ ...document.querySelector('#integration-reads').dataset })`)
  if (reads.stats !== '0' || reads.billing !== '0') {
    throw new Error(`Unused global queries still ran: ${JSON.stringify(reads)}`)
  }
  return { historyScopeReturn: true, historyReplyFence: true, clean: true, dirty: true, unavailable: true, timeout: true, ipcRejection: true, refreshRetainsEvidence: true, sourceTime: true, sameWorkspaceReplyOrdered: true, staleReplyRejected: true, unbound: true, nativeInput: true, analyticsStillRefreshes: true, unusedGlobalQueries: reads }
}
