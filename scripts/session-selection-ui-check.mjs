export async function exerciseSessionSelection(contents, scenario) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`${scenario}: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing selection control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Selection control obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const state = `JSON.parse(document.querySelector('#selection-state').textContent)`
  await wait(`${state}.snapshots === 2`)
  if (scenario !== 'late-startup' && scenario !== 'late-startup-loading') {
    await click('#resolve-snapshots')
    await wait(`document.querySelector('.sb-sess.active')?.textContent.includes('Old running conversation')`)
  }
  const baseline = await read(`${state}.activeReads`)
  if (scenario === 'stale-live' || scenario === 'stale-run') {
    await click('#start-hidden-pi')
    const initialListReads = await read(`${state}.activeListReads`)
    if (await read(`document.querySelector('.sb-sess[data-provider="pi"]').classList.contains('running')`) !== (scenario === 'stale-run')) throw new Error('Fixture sidebar must retain its stale running state')
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 1`)
    await click('#resolve-history')
    await wait(`document.querySelector('.chat-transcript').textContent.includes('Actual live response before archival') && !document.querySelector('.chat-session-evidence-gap')`)
    const result = await read(state)
    if (result.activeListReads !== initialListReads + 1 || result.historyReads !== 1 || result.adoptedRuns.join(',') !== 'hidden-pi-run' || result.activeReads !== baseline || result.starts !== 0) throw new Error(`Stale sidebar selection did not restore a single authoritative read: ${JSON.stringify(result)}`)
    return { scenario, firstClickLiveContent: true, missingArchiveNotEmpty: true, authoritativeRunLookup: true, noRetryOrStart: true }
  }
  if (scenario === 'new-draft') {
    const input = 'textarea[aria-label="描述任务"]'
    const newButton = '.sb-new'
    const newDraft = '未发送的新会话草稿\n第二行继续保留'
    const existingDraft = '已有会话自己的草稿'
    const projectDraft = '另一个项目的新会话草稿'
    const type = async (value) => {
      contents.focus()
      await click(input)
      await wait(`document.activeElement === document.querySelector(${JSON.stringify(input)})`)
      contents.selectAll()
      if (value) await contents.insertText(value)
      else {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      }
      await wait(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(value)}`)
    }
    await click(newButton)
    await wait(`document.querySelector(${JSON.stringify(input)})?.value === '' && ${state}.newSessions === 1`)
    await type(newDraft)
    if (await read(`document.querySelector('.sb-draft') != null`)) throw new Error('A new workspace draft marked an existing session')
    await click('.sb-sess.running')
    await wait(`${state}.historyReads === 1`)
    await click('#resolve-history')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ''`)
    await type(existingDraft)
    await wait(`document.querySelector('.sb-sess.running .sb-draft')?.textContent === '草稿'`)
    if (!await read(`(() => {
      const row = document.querySelector('.sb-sess.running')
      const draft = row.querySelector('.sb-draft')
      const title = row.querySelector('.sb-sesstext')
      const time = row.querySelector('.sb-sesstime')
      return draft.nextElementSibling === title && draft.getBoundingClientRect().right <= time.getBoundingClientRect().left &&
        getComputedStyle(draft).whiteSpace === 'nowrap' && document.activeElement === document.querySelector(${JSON.stringify(input)})
    })()`)) throw new Error('Draft label displaced session metadata or interrupted typing focus')
    await click(newButton)
    await wait(`document.querySelector('.sb-sess.running:not(.active) .sb-draft') != null`)
    if (await read(`document.querySelector('.sb-sess[data-provider="pi"] .sb-draft') != null`)) throw new Error('Draft leaked to another Provider/profile')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(newDraft)}`)
    await click(newButton)
    await wait(`${state}.newSessions === 3 && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(newDraft)}`)
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 2`)
    await click('#resolve-history')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ''`)
    await click(newButton)
    await wait(`${state}.newSessions === 4 && document.querySelector(${JSON.stringify(input)}).value === ''`)
    await type(projectDraft)
    await click('.sb-sess.running')
    await wait(`${state}.historyReads === 3`)
    await click('#resolve-history')
    await wait(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(existingDraft)}`)
    await type('')
    await wait(`document.querySelector('.sb-sess.running .sb-draft') == null`)
    await type('   ')
    if (await read(`document.querySelector('.sb-sess.running .sb-draft') != null`)) throw new Error('Whitespace-only input was marked as a draft')
    await type(existingDraft)
    await wait(`document.querySelector('.sb-sess.running .sb-draft') != null`)
    await click(newButton)
    await wait(`${state}.newSessions === 5 && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(newDraft)}`)
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 4`)
    await click('#resolve-history')
    await click(newButton)
    await wait(`${state}.newSessions === 6 && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(projectDraft)}`)
    if (await read(`${state}.starts`) !== 0) throw new Error('Restoring a draft started a Provider')
    return { scenario, newDraftRestored: true, existingDraftPreserved: true, projectDraftIsolated: true, repeatedNewPreserved: true, sidebarDraftPresence: true, clearAndWhitespace: true, draftLayoutAndFocus: true, noImplicitSend: true }
  }
  if (scenario === 'focused-event') await click('#focus-pi')
  else await click('.sb-sess[data-provider="pi"]:not(.running)')
  await wait(`${state}.historyReads === 1`)
  if (scenario === 'repeat-pending') {
    await click('.sb-sess[data-provider="pi"]')
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (await read(`${state}.historyReads !== 1 || document.querySelector('.chat-transcript')?.getAttribute('aria-busy') !== 'true'`)) {
      throw new Error('Repeated pending selection restarted history or cleared its loading state')
    }
    await wait(`document.querySelector('[data-status="loading"]')?.textContent.includes('正在加载会话历史')`)
    if (await read(`document.body.innerText.includes('这条会话暂时没有可显示的轮次')`)) throw new Error('Pending history was reported as empty')
  }
  if (scenario !== 'late-startup') await click('#resolve-snapshots')
  if (scenario === 'late-startup-loading') {
    await wait(`${state}.snapshots === 0`)
    // Let both bootstrap promises and React effects settle while history is still pending.
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (await read(`${state}.cancelledLoads !== 0 || ${state}.cwd !== '/fixture/new'`)) {
      throw new Error(`${scenario}: late bootstrap cancelled the pending history: ${JSON.stringify(await read(state))}`)
    }
  }
  const expectedCancellations = scenario === 'rapid-switch' ? 2 : 0
  if (scenario === 'rapid-switch') {
    await click('.sb-sess[data-provider="claude"]')
    await wait(`${state}.historyReads === 2`)
    await click('.sb-sess[data-provider="pi"]')
    await wait(`${state}.historyReads === 3`)
  }
  await click('#resolve-history')
  await wait(`document.body.innerText.includes('History for new-session')`)
  if (scenario === 'late-startup') {
    await click('#resolve-snapshots')
    await wait(`${state}.snapshots === 0`)
  }
  const result = await read(state)
  // Explicit focus restores a live Pi run; history-only selection must not retain the old live run.
  if (scenario !== 'focused-event' && await read(`document.querySelector('.run-status') != null`)) {
    throw new Error(`${scenario}: stale startup run leaked into history`)
  }
  if (result.cancelledLoads !== expectedCancellations || result.cwd !== '/fixture/new' || result.activeReads !== baseline) {
    throw new Error(`${scenario}: stale startup recovery disturbed selection: ${JSON.stringify(result)}`)
  }
  if (await read(`document.body.innerText.includes('workspace changed')`)) throw new Error(`${scenario}: workspace error visible`)
  // Switch back to the running session, including within the same Provider/profile.
  await click('.sb-sess.running')
  await wait(`${state}.historyReads === ${expectedCancellations + 2}`)
  await click('#resolve-history')
  await wait(`document.body.innerText.includes('History for old-session')`)
  if (await read(`${state}.activeReads`) !== baseline) throw new Error(`${scenario}: reverse switch restarted bootstrap`)
  return { scenario, providerSwitch: scenario !== 'same-provider', reverseSwitch: true, startupReads: baseline, expectedCancellations }
}
