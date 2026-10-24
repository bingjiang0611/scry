import assert from 'node:assert/strict'
import { connectCdp } from './electron-security-cdp.mjs'

export async function exerciseRestart(smokeContext) {
  const { port, terminalSmoke, stopOwnedApp, waitForTarget } = smokeContext
  let { child, cdp } = smokeContext
  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed')
    return response.result?.value
  }
  cdp.close()
  // Ownership is captured outside Electron before the crash. Confirm the registered tree is
  // gone before restarting, rather than treating only the parent's exit as cleanup success.
  await stopOwnedApp(child, { crash: true })
  child = undefined
  child = smokeContext.launchApp()
  const restarted = await waitForTarget(port, () => child)
  cdp = connectCdp(restarted.page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const historyRestart = await evaluate(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8_000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
      if (!predicate()) throw new Error('cold terminal history UI condition timed out: ' + predicate.toString() + '; ' + document.querySelector('.terminal-surface')?.innerText?.slice(-1500))
    }
    await waitFor(() => !!document.querySelector('button.sb-sess'))
    document.querySelector('button.sb-sess').click()
    await waitFor(() => !!document.querySelector('button.sb-sess[aria-current="true"]'))
    const id = ${JSON.stringify(terminalSmoke.bound.id)}
    const cold = await window.scry.terminalRecordingList()
    const entry = cold.items.find((item) => item.id === id)
    const toggle = document.querySelector('button[title="右侧工作区"]')
    if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click()
    await waitFor(() => !!document.querySelector('button[aria-label="添加 Surface"]'))
    let terminalTab = [...document.querySelectorAll('.surface-tab-activate')].find((node) => node.textContent.includes('终端'))
    if (!terminalTab) {
      document.querySelector('button[aria-label="添加 Surface"]').click()
      await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent.trim().startsWith('终端')))
      ;[...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim().startsWith('终端')).click()
    } else terminalTab.click()
    await waitFor(() => !!document.querySelector('.terminal-state.running'))
    const before = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    document.querySelector('button[aria-label="终端录制历史"]').click()
    await waitFor(() => !!document.querySelector('[data-recording-id="' + id + '"] button'))
    const row = document.querySelector('[data-recording-id="' + id + '"]')
    const modal = row.closest('[role="dialog"]')
    const modalAccessible = modal.getAttribute('aria-modal') === 'true' && modal.contains(document.activeElement)
    const rect = modal.getBoundingClientRect()
    const modalVisible = rect.width > 200 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && [[rect.left + 24, rect.top + 24], [rect.right - 24, rect.bottom - 24]].every(([x, y]) => modal.contains(document.elementFromPoint(x, y)))
    row.querySelector('button').click()
    await waitFor(() => document.querySelector('.terminal-pane:not([hidden]) .xterm-rows')?.textContent.includes('__SCRY_TERMINAL_WORKSPACE_OK__'))
    const readonly = document.querySelector('button[aria-label="重新启动终端"]').disabled
    const after = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    const oldWriteRejected = await window.scry.terminalWrite(id, 1, 'no-old-shell') === false
    await window.scry.setCwd(null)
    const foreignHidden = !(await window.scry.terminalRecordingList()).items.some((item) => item.id === id)
    let foreignReadRejected = false
    try { await window.scry.terminalRecordingRead({ id, offset: 0 }) } catch { foreignReadRejected = true }
    return { found: !!entry && !entry.active, replayed: true, readonly, modalAccessible, modalVisible,
      noSpawn: JSON.stringify(before) === JSON.stringify(after), oldWriteRejected, foreignHidden, foreignReadRejected }
  })()`)
  assert.deepEqual(historyRestart, { found: true, replayed: true, readonly: true, modalAccessible: true, modalVisible: true,
    noSpawn: true, oldWriteRejected: true, foreignHidden: true, foreignReadRejected: true })
  cdp.close()
  return { historyRestart, cdp, child }
}
