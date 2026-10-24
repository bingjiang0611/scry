import assert from 'node:assert/strict'

export async function exerciseRecording(smokeContext) {
  const { evaluate, initialTargets, page, port, waitForTarget } = smokeContext
  const recordingSmoke = await evaluate(`(async () => {
    const root = () => document.querySelector('[data-session-surface-current="true"]')
    const query = (selector) => selector.startsWith('button.sb-sess') || selector.includes('title="右侧工作区"')
      ? document.querySelector(selector) : root()?.querySelector(selector)
    const queryAll = (selector) => root()?.querySelectorAll(selector) ?? []
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8_000
      while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
      if (!await predicate()) throw new Error('terminal recording UI condition timed out: ' + JSON.stringify({
        text: query('.terminal-surface')?.textContent?.slice(-1500),
        host: query('.terminal-pane:not([hidden]) .terminal-xterm')?.getBoundingClientRect().toJSON()
      }))
    }
    await waitFor(() => !!query('button.sb-sess'))
    query('button.sb-sess')?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await waitFor(() => !!query('button[title="右侧工作区"]'))
    const toggle = query('button[title="右侧工作区"]')
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click()
    await waitFor(() => !!query('.right-surface-panel'))
    let terminalTab = [...queryAll('.surface-tab-activate')].find((node) => node.textContent.includes('终端'))
    if (!terminalTab) {
      query('button[aria-label="添加 Surface"]')?.click()
      await waitFor(() => [...queryAll('[role="menuitem"]')].some((node) => node.textContent?.trim().startsWith('终端')))
      ;[...queryAll('[role="menuitem"]')].find((node) => node.textContent?.trim().startsWith('终端'))?.click()
    } else terminalTab.click()
    const button = (label) => query('button[aria-label="' + label + '"]')
    await waitFor(() => query('.terminal-pane:not([hidden]) .terminal-xterm')?.clientWidth > 0)
    const priorIds = new Set((await window.scry.terminalRecordingList()).items.map((item) => item.id))
    button('重新启动终端').click()
    let startedId = null
    await waitFor(async () => {
      startedId = (await window.scry.terminalRecordingList()).items.find((item) => item.active && !priorIds.has(item.id))?.id
      return !!startedId && !!query('.terminal-state.running')
    })
    const disabledWhileRunning = button('回放终端录制').disabled && button('删除终端录制').disabled
    let offExit = () => {}
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { offExit(); reject(new Error('UI terminal did not exit')) }, 8_000)
      offExit = window.scry.onTerminalExit((event) => {
        if (event.id === startedId) { clearTimeout(timer); offExit(); resolve(event) }
      })
    })
    const textarea = query('.terminal-pane:not([hidden]) .xterm-helper-textarea')
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', "printf '__SCRY_RECORDING_SENTINEL__\\\\n'; exit")
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    const ended = await exit
    await waitFor(() => !button('回放终端录制').disabled)
    const recordingPage = await window.scry.terminalRecordingRead({ id: ended.id, offset: 0, limit: 65536 })
    if (!recordingPage.data.includes('__SCRY_RECORDING_SENTINEL__')) throw new Error('UI Shell recording is missing its marker')
    button('清空终端显示').click()
    button('回放终端录制').click()
    await waitFor(() => query('.terminal-foot')?.textContent.includes('录制回放完成'))
    // The footer is set only after xterm's write callback confirms parsing. DOM painting is renderer-dependent.
    const rendered = recordingPage.data
    query('.terminal-tab.active .terminal-tab-close').click()
    const beforeHistory = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    button('终端录制历史').click()
    await waitFor(() => !!query('[data-recording-id="' + ended.id + '"] button'))
    query('[data-recording-id="' + ended.id + '"] button').click()
    await waitFor(() => query('.terminal-foot')?.textContent.includes('录制回放完成'))
    const readonly = button('重新启动终端').disabled
    const afterHistory = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    const noSpawn = JSON.stringify(beforeHistory) === JSON.stringify(afterHistory)
    button('删除终端录制').click()
    await waitFor(() => query('.terminal-foot')?.textContent.includes('磁盘录制已删除'))
    let deleted = false
    try { await window.scry.terminalRecordingRead({ id: ended.id, offset: 0 }) } catch { deleted = true }
    query('.terminal-tab.active .terminal-tab-close').click()
    button('新建终端').click()
    await waitFor(() => !!query('.terminal-state.running'))
    return { disabledWhileRunning, state: recordingPage.state, captured: recordingPage.data.includes('__SCRY_RECORDING_SENTINEL__'),
      replayed: rendered.includes('__SCRY_RECORDING_SENTINEL__'), readonly, noSpawn, deleted }
  })()`)
  assert.deepEqual(recordingSmoke, { disabledWhileRunning: true, state: 'complete', captured: true, replayed: true, readonly: true, noSpawn: true, deleted: true })

  const popupOpened = await evaluate(`window.open('file:///scry-smoke') !== null`)
  assert.equal(popupOpened, false)
  await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  const afterPopupTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  assert.equal(afterPopupTargets.filter((target) => target.type === 'page').length, initialTargets.filter((target) => target.type === 'page').length)

  await evaluate(`location.assign('file:///scry-navigation-smoke')`)
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  const afterNavigation = await waitForTarget(port, () => undefined, 2_000)
  assert.equal(afterNavigation.page.url, page.url, 'will-navigate failed to keep renderer on its trusted URL')

  return { recordingSmoke }
}
