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
    ['reject', 'failed', '采集失败'],
    ['pending', 'pending', '采集中']
  ]) {
    await click(`#diff-${mode}`)
    await wait(state(status, text))
    if (status !== 'captured' && await read(`document.querySelector('#diff-report').textContent.includes('**git diff**：无改动')`)) {
      throw new Error('Missing Git evidence was exported as a clean workspace')
    }
  }
  await click('#diff-switch')
  await wait(state('captured', '无改动'))
  await click('#diff-release')
  // The rejected older context must not replace the second project's accepted result.
  await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  if (!(await read(state('captured', '无改动')))) throw new Error('Stale Git reply replaced the current workspace')
  await click('#diff-unbind')
  await wait(`!document.querySelector('#diff-summary [role="status"]') && !document.querySelector('#diff-overview [data-evidence]')`)
  return { clean: true, dirty: true, unavailable: true, timeout: true, ipcRejection: true, pending: true, staleReplyRejected: true, unbound: true, nativeInput: true }
}
