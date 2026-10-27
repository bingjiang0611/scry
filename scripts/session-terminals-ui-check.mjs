export async function exerciseSessionTerminals(contents, scenario, pointerSource) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Terminal ${scenario}: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(node => node.getBoundingClientRect().width > 0)`)
    await read(`(() => {
      document.querySelector('[data-terminal-fixture-target]')?.removeAttribute('data-terminal-fixture-target');
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getBoundingClientRect().width > 0);
      node.setAttribute('data-terminal-fixture-target', 'true');
    })()`)
    const point = await read(`(${pointerSource})('[data-terminal-fixture-target]', { timeoutMs: 5000, scroll: true, captureReceipt: true })`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await wait('window.__nativeUiPointerReceipt?.trusted && window.__nativeUiPointerReceipt.targetMatched')
  }
  const clickTerminalSurface = async () => {
    await wait(`document.querySelector('.surface-menu') != null`)
    // New surfaces can change menu positions. Keep the terminal contract name-bound,
    // while still using native coordinate input and the existing hit-test assertions.
    const index = await read(`[...document.querySelectorAll('.surface-menu [role="menuitem"]')].findIndex(node => node.textContent.trim().startsWith('终端'))`)
    if (index < 0) throw new Error('Terminal surface is missing from the menu')
    await click(`.surface-menu [role="menuitem"]:nth-child(${index + 1})`)
  }
  const state = `JSON.parse(document.querySelector('#terminal-state').textContent)`
  const originalStarts = scenario === 'restored' ? 0 : 1
  const select = async (selector, id) => {
    await click(selector)
    await wait(`document.querySelector('.chat').textContent.includes('History for ${id}')`)
  }
  // Use data-project-path so Sidebar grouping/header layout cannot flatten identity.
  const session = (project, index) => `.sb-proj:has([data-project-path="/fixture/${project}"]) .sb-sess-row:nth-child(${index} of .sb-sess-row) .sb-sess`
  await wait(`document.querySelectorAll('.sb-sess').length === 3`)
  await select(session('old', 1), 'one')
  await click('[aria-label="右侧工作区"]')
  await wait(`document.querySelector('[aria-label="添加 Surface"]') != null`)
  await click('[aria-label="添加 Surface"]')
  await clickTerminalSurface()
  await wait(`document.querySelector('.terminal-xterm .xterm') != null`)
  await read(`globalThis.originalXterm = document.querySelector('.terminal-xterm .xterm')`)
  if (scenario === 'pending') await wait(`${state}.pending`)
  else {
    await wait(`document.querySelector('.terminal-state.running') != null && document.querySelector('.terminal-xterm').textContent.includes('original-screen-marker')`)
    contents.focus()
    await click('.terminal-xterm')
    await wait(`document.activeElement.classList.contains('xterm-helper-textarea')`)
    await contents.insertText('preserved-input')
    await wait(`${state}.writes.join('').includes('preserved-input') && document.querySelector('.terminal-xterm').textContent.includes('preserved-input')`)
  }
  await select(session('old', 2), 'two')
  if (!await read(`globalThis.originalXterm.getBoundingClientRect().width === 0 && document.querySelector('.right-panel-hidden') != null`)) throw new Error('Same-workspace conversation inherited previous right tabs')
  await select(session('new', 1), 'three')
  if (!await read(`globalThis.originalXterm.getBoundingClientRect().width === 0 && document.querySelector('.right-panel-hidden') != null`)) throw new Error('Cross-workspace conversation inherited previous right tabs')
  if (scenario === 'pending') {
    await click('#resolve-terminal')
    await wait(`document.querySelector('.terminal-state.running') != null`)
  }
  if (!await read(`document.querySelector('.terminal-xterm .xterm') === globalThis.originalXterm && ${state}.starts.length === ${originalStarts} && ${state}.attaches.length === ${scenario === 'restored' ? 1 : 0} && ${state}.closes.length === 0`)) {
    throw new Error(`Terminal ${scenario}: session switch reloaded the terminal: ${JSON.stringify(await read(state))}`)
  }
  if (!await read(`document.querySelector('.terminal-xterm').getAttribute('aria-label').includes('/fixture/old')`)) throw new Error('Terminal mislabeled its startup directory after navigation')
  await select(session('old', 1), 'one')
  await click('[aria-label="右侧工作区"]')
  await wait(`document.querySelector('.right-panel-hidden') != null`)
  await click('[aria-label="右侧工作区"]')
  await wait(`document.querySelector('.right-panel-hidden') == null && document.querySelector('.terminal-xterm .xterm') === globalThis.originalXterm`)
  await select(session('old', 1), 'one')
  await wait(`document.querySelector('.terminal-xterm .xterm') === globalThis.originalXterm && document.querySelector('.terminal-xterm').textContent.includes('original-screen-marker')`)
  if (scenario !== 'pending' && !await read(`document.querySelector('.terminal-xterm').textContent.includes('preserved-input')`)) throw new Error('Terminal lost screen contents')
  await click('.terminal-xterm')
  await wait(`document.activeElement.classList.contains('xterm-helper-textarea')`)
  await contents.insertText('continued-input')
  await wait(`${state}.writes.join('').includes('continued-input') && document.querySelector('.terminal-xterm').textContent.includes('continued-input')`)
  await click('[aria-label="终端录制历史"]')
  await wait(`document.querySelector('[aria-label="只读打开 terminal-recorded"]') != null`)
  await click('[aria-label="只读打开 terminal-recorded"]')
  await wait(`document.querySelector('.terminal-state.readonly') != null && document.querySelectorAll('.terminal-xterm')[1].textContent.includes('recorded-marker')`)
  await read(`globalThis.recordedXterm = document.querySelectorAll('.terminal-xterm .xterm')[1]`)
  await select(session('new', 1), 'three')
  if (!await read(`document.querySelectorAll('.terminal-xterm .xterm')[1] === globalThis.recordedXterm && document.querySelector('.terminal-state.readonly') != null && document.querySelectorAll('.terminal-xterm')[1].textContent.includes('recorded-marker')`)) throw new Error('Session switch discarded the read-only recording')
  if (!await read(`globalThis.recordedXterm.getBoundingClientRect().width === 0`)) throw new Error('Previous conversation recording remained visible')
  await select(session('old', 1), 'one')
  await click('.terminal-tab:nth-child(2) .terminal-tab-close')
  await wait(`document.querySelectorAll('.terminal-tab').length === 1`)
  await click('#terminal-exit')
  await wait(`document.querySelector('.terminal-state.exited') != null && document.querySelector('.terminal-xterm').textContent.includes('code 1')`)
  await select(session('new', 1), 'three')
  await select(session('old', 1), 'one')
  if (!await read(`document.querySelector('.terminal-state.exited') != null && ${state}.starts.length === ${originalStarts}`)) throw new Error('Session switch restarted an exited Shell')
  await click('[aria-label="重新启动终端"]')
  await wait(`${state}.starts.length === ${originalStarts + 1} && document.querySelector('.terminal-state.running') != null`)
  await click('[aria-label="新建终端"]')
  await wait(`${state}.starts.length === ${originalStarts + 2} && document.querySelectorAll('.terminal-state.running').length === 2`)
  if (!await read(`${state}.starts.slice(-2).every(request => request.cwd === '/fixture/old')`)) throw new Error('Explicit terminal start did not use its owning workspace')
  await click('.terminal-tab:first-child .terminal-tab-close')
  await wait(`${state}.closes.length === 1 && document.querySelectorAll('.terminal-tab').length === 1`)
  await select(session('old', 2), 'two')
  await click('[aria-label="右侧工作区"]')
  await click('[aria-label="添加 Surface"]')
  await clickTerminalSurface()
  await wait(`${state}.starts.length === ${originalStarts + 3}`)
  if (!await read(`${state}.attaches.length === ${scenario === 'restored' ? 1 : 0} && ${state}.starts.at(-1).scopeId !== ${state}.starts.at(-2).scopeId`)) throw new Error('Same-workspace terminal adopted another conversation shell')
  await select(session('new', 1), 'three')
  await click('[aria-label="右侧工作区"]')
  await click('[aria-label="添加 Surface"]')
  await clickTerminalSurface()
  await wait(`${state}.starts.length === ${originalStarts + 4}`)
  if (!await read(`${state}.starts.at(-1).cwd === '/fixture/new' && ${state}.closes.length === 1`)) throw new Error('New conversation terminal changed old shells')
  await select(session('old', 1), 'one')
  await click('.chat .md-file-ref')
  await wait(`document.querySelector('[data-session-surface-current="true"] .workspace-textarea')?.value === '/fixture/new/same.ts'`)
  await read(`globalThis.foreignEditor = document.querySelector('[data-session-surface-current="true"] .workspace-textarea')`)
  if (!await read(`globalThis.foreignEditor.readOnly`)) throw new Error('Cross-workspace reference became writable')
  await select(session('old', 2), 'two')
  await click('.chat .md-file-ref')
  await wait(`document.querySelector('[data-session-surface-current="true"] .workspace-textarea')?.value === '/fixture/old/same.ts'`)
  if (!await read(`globalThis.foreignEditor.isConnected && globalThis.foreignEditor.readOnly && globalThis.foreignEditor.value === '/fixture/new/same.ts'`)) throw new Error('Opening another conversation file changed the retained editor root')
  await click('[data-session-surface-current="true"] .workspace-textarea')
  contents.focus()
  await wait(`document.activeElement === document.querySelector('[data-session-surface-current="true"] .workspace-textarea')`)
  await contents.insertText('unsaved-marker')
  await wait(`document.querySelector('[data-session-surface-current="true"] .workspace-textarea').value.includes('unsaved-marker')`)
  await read(`globalThis.localEditor = document.querySelector('[data-session-surface-current="true"] .workspace-textarea'); globalThis.discardPrompts = 0; globalThis.originalConfirm = window.confirm; window.confirm = () => { globalThis.discardPrompts++; return false }; true`)
  await select(session('new', 1), 'three')
  if (!await read(`globalThis.discardPrompts === 0 && globalThis.localEditor.isConnected && globalThis.localEditor.value.includes('unsaved-marker')`)) throw new Error('Workspace navigation discarded or asked to discard a retained editor')
  await select(session('old', 1), 'one')
  await wait(`globalThis.foreignEditor.getBoundingClientRect().width > 0 && globalThis.foreignEditor.readOnly`)
  await click('[data-session-surface-current="true"] .surface-tab-activate[aria-controls$="-terminal-panel"]')
  await wait(`document.querySelector('[data-session-surface-current="true"] .terminal-xterm .xterm')?.getBoundingClientRect().width > 0`)
  await read(`globalThis.promotedXterm = [...document.querySelectorAll('.terminal-xterm .xterm')].find(node => node.getBoundingClientRect().width > 0)`)
  await click('#promote-session')
  await wait(`JSON.parse(sessionStorage.getItem('scry.session-right-surfaces.v1')).some(([key]) => JSON.parse(key).at(-1) === 'native-one')`)
  if (!await read(`globalThis.promotedXterm.isConnected && globalThis.promotedXterm.getBoundingClientRect().width > 0 && ${state}.starts.length === ${originalStarts + 4}`)) throw new Error('Native session capture remounted its workbench')
  await select(session('new', 1), 'three')
  await select(session('old', 1), 'native-one')
  if (!await read(`globalThis.promotedXterm.isConnected && globalThis.promotedXterm.getBoundingClientRect().width > 0`)) throw new Error('Captured conversation lost its terminal identity')
  await click('#merge-session')
  await wait(`document.querySelector('[aria-label="切换此会话的保留工作区"]')?.textContent.includes('1/2')`)
  const mergedScope = await read(`JSON.parse(sessionStorage.getItem('scry.session-right-surfaces.v1')).find(([key]) => { try { return JSON.parse(key).at(-1) === 'two' } catch { return false } })[1]`)
  if (!mergedScope.relatedIds?.length) throw new Error('Promotion collision orphaned the existing native workbench')
  await click('[aria-label="切换此会话的保留工作区"]')
  await wait(`globalThis.promotedXterm.getBoundingClientRect().width === 0 && document.querySelector('[data-session-surface-current="true"] .workspace-textarea')?.getBoundingClientRect().width > 0`)
  if (!await read(`globalThis.localEditor.value.includes('unsaved-marker')`)) throw new Error('Promotion discarded unsaved editor text')
  // Explicitly discard only after proving preservation, so beforeunload does not block the next fixture.
  await read(`window.confirm = () => true; true`)
  await click('[data-session-surface-current="true"] .workspace-editorbar button:first-of-type')
  await wait(`globalThis.localEditor.value === '/fixture/old/same.ts' && !document.querySelector('[data-session-surface-current="true"] .workspace-editorbar').textContent.includes('未保存')`)
  await read(`window.confirm = globalThis.originalConfirm; true`)
  await click('[data-session-surface-current="true"] .surface-tab-activate[aria-controls$="-terminal-panel"]')
  await wait(`[...document.querySelectorAll('.terminal-xterm .xterm')].some(node => node !== globalThis.promotedXterm && node.getBoundingClientRect().width > 0)`)
  await click('[aria-label="切换此会话的保留工作区"]')
  await wait(`globalThis.promotedXterm.getBoundingClientRect().width > 0`)
  if (!await read(`${state}.closes.length === 1 && ${state}.starts.length === ${originalStarts + 4}`)) throw new Error('Merged workbench switching restarted shells')
  // The dirty indicator updates before React removes its beforeunload protection.
  // Wait for that protection to clear before navigating to the next fixture.
  await wait('window.dispatchEvent(new Event("beforeunload", { cancelable: true }))')
  return { scenario, scopedTabs: true, sameWorkspace: true, crossWorkspace: true, screenPreserved: true, recordingPreserved: true, fileRootAndReadOnlyPreserved: true, hideShowPreserved: true, nativePromotion: true, collisionReachable: true, noImplicitRestart: true, explicitRestartAndNewUseOwnedCwd: true, explicitClose: true }
}
