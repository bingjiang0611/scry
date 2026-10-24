export async function exerciseSessionModels(contents, screenshotPath) {
  const read = async (expression) => {
    const result = await contents.executeJavaScript(`(async () => {
      try { return { ok: true, value: await (${expression}) }; }
      catch (error) { return { ok: false, error: String(error) }; }
    })()`)
    if (!result.ok) throw new Error(`Session model expression failed: ${expression.slice(0, 500)}; ${result.error}`)
    return result.value
  }
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Session models: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing model control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    try {
      await wait(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x}, ${point.y}))`)
    } catch (error) {
      throw new Error(`${error.message}; hit=${await read(`document.elementFromPoint(${point.x}, ${point.y})?.outerHTML`)}`)
    }
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const pickSession = async (text) => {
    const index = await read(`[...document.querySelectorAll('.sb-sess')].findIndex(node => node.textContent.includes(${JSON.stringify(text)}))`)
    if (index < 0) throw new Error(`Missing session ${text}`)
    await click(`.sb-sess-row:nth-child(${index + 1} of .sb-sess-row) .sb-sess`)
  }
  const modelIs = (id) => `document.querySelector('.model-effort-model')?.textContent === ${JSON.stringify(id)}`
  const chooseModel = async (id) => {
    await click('[aria-label="选择 Model 与 Effort"]')
    await wait(`document.querySelector('.model-effort-current-model') != null`)
    await click('[aria-label^="选择 Model，"]')
    await wait(`document.querySelectorAll('.model-effort-list [role="option"]').length === 3`)
    await click(`.model-effort-list [role="option"]:nth-child(${id === 'model-1' ? 2 : 3})`)
    await wait(modelIs(id))
    await click('[aria-label="选择 Model 与 Effort"]')
    await wait(`document.querySelector('.model-effort-popover') == null`)
  }
  const send = async (text) => {
    await click('textarea[aria-label="描述任务"]')
    await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
    await contents.insertText(text)
    await wait(`document.querySelector('textarea').value === ${JSON.stringify(text)} && !document.querySelector('.send').disabled`)
    await click('.send')
  }
  const requests = `JSON.parse(document.querySelector('#model-state').textContent).requests`
  contents.focus()
  await wait(`document.querySelector('.sb-proj-new') != null`)
  await click('.sb-proj-new')
  await wait(`document.querySelector('[aria-label="选择 Model 与 Effort"]')?.disabled === false`)
  await chooseModel('model-1')
  await click('[aria-label="选择 Model 与 Effort"]')
  await wait(`document.querySelector('[aria-label="推理强度"]') != null`)
  await click('[aria-label="推理强度"]')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await wait(`document.querySelector('.model-effort-effort')?.textContent === 'High'`)
  await click('[aria-label="选择 Model 与 Effort"]')
  await send('Conversation one')
  await wait(`${requests}.length === 1 && document.querySelector('.run-status') != null`)
  await click('#capture-first')
  await wait(`document.querySelector('.sb-sess') != null && ${modelIs('model-1')}`)
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-1')}`)
  await chooseModel('model-2')
  await send('Conversation two')
  await wait(`${requests}.length === 2 && document.querySelectorAll('.sb-sess').length === 2`)
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-2')}`)
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') != null && ${modelIs('model-1')}`)
  await click('#finish-second')
  await wait(`document.querySelectorAll('.sb-sess.running').length === 1 && ${modelIs('model-1')}`)
  await send('Queued continuation one')
  await wait(`document.querySelector('textarea').value === ''`)
  if (await read(`${requests}.length`) !== 2) throw new Error('Busy session did not queue its continuation')
  await click('#finish-first')
  await wait(`${requests}.length === 3`)
  const actual = await read(requests)
  if (actual.map((request) => request.model?.id).join(',') !== 'model-1,model-2,model-1' || actual[2].expectedExternalSessionId !== 'native-1' || actual[0].effort !== 'high' || actual[1].effort != null || actual[2].effort !== 'high') {
    throw new Error('Wrong per-session request models: ' + JSON.stringify(actual))
  }
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-2')}`)
  await click('#remount')
  await wait(modelIs('model-2'))
  await pickSession('Conversation two')
  await wait(modelIs('model-2'))
  await pickSession('Conversation one')
  await wait(modelIs('model-1'))
  await click('#legacy')
  await wait(`document.querySelectorAll('.sb-sess').length === 3`)
  await pickSession('Legacy conversation')
  await wait(`${modelIs('model-1')} && document.querySelector('.model-effort-effort')?.textContent === 'High'`)
  await click('.sb-new')
  await wait(`document.querySelector('.run-status') == null && ${modelIs('model-2')}`)
  const capabilities = `JSON.parse(document.querySelector('#model-state').textContent).capabilityRequests`
  if (!await read(`${capabilities}.skills.length === 0 && ${capabilities}.mcp.length === 0`)) {
    throw new Error('Skills/MCP inventory loaded before opening its page')
  }
  if (!await read(`document.querySelector('.sb-nav .sb-navmeta') == null && document.querySelector('.sb-nav .sb-navdot') == null`)) {
    throw new Error('Skills/MCP navigation still displays background inventory metadata')
  }
  await click('.sb-new')
  await wait(modelIs('model-2'))
  await click('.sb-nav [title="Skills"]')
  await wait(`${capabilities}.skills.length === 1 && document.querySelector('.capabilities-modal--skills')?.textContent.includes('fixture Skill unavailable')`)
  if (!await read(`${capabilities}.mcp.length === 0`)) throw new Error('Opening Skills also loaded MCP')
  await click('.capability-kind-tabs [role="tab"]:nth-child(2)')
  await wait(`${capabilities}.mcp.length === 1 && document.querySelector('.capabilities-modal--mcp')?.textContent.includes('fixture MCP unavailable')`)
  await click('[aria-label="刷新 MCP 运行状态"]')
  await wait(`${capabilities}.mcp.length === 2`)
  await click('[aria-label="关闭能力面板"]')

  const selectAgent = async (id) => {
    await click('.clibtn')
    await wait(`document.querySelector('.climenu [data-agent-id="${id}"]') != null`)
    await click(`.climenu [data-agent-id="${id}"]`)
    await wait(`document.querySelector('.clibtn').dataset.agentId === '${id}'`)
  }
  await selectAgent('codex')
  if (!await read(`${capabilities}.skills.length === 1 && ${capabilities}.mcp.length === 2`)) throw new Error('Hidden inventory refreshed on Provider switch')
  await click('.sb-nav [title="Skills"]')
  await wait(`${capabilities}.skills.length === 2`)
  if (!await read(`${capabilities}.skills.at(-1).providerId === 'codex'`)) throw new Error('Skills loaded the previous Provider context')
  await click('[aria-label="关闭能力面板"]')
  await selectAgent('pi:first')
  await click('.sb-nav [title="MCP"]')
  await wait(`${capabilities}.mcp.length === 3`)
  if (!await read(`${capabilities}.mcp.at(-1).agentProfileId === 'pi:first'`)) throw new Error('MCP lost its Pi Profile context')
  await click('[aria-label="关闭能力面板"]')
  await selectAgent('pi:second')
  if (!await read(`${capabilities}.skills.length === 2 && ${capabilities}.mcp.length === 3`)) throw new Error('Hidden inventory refreshed on Pi Profile switch')
  await click('.sb-nav [title="Skills"]')
  await wait(`${capabilities}.skills.length === 3`)
  if (!await read(`${capabilities}.skills.at(-1).agentProfileId === 'pi:second'`)) throw new Error('Skills loaded the previous Pi Profile')
  await click('[aria-label="关闭能力面板"]')
  await click('#remount')
  await wait(`document.querySelector('.clibtn')?.dataset.agentId === 'pi:second'`)
  if (!await read(`${capabilities}.skills.length === 3 && ${capabilities}.mcp.length === 3`)) throw new Error('Remount restarted hidden inventory discovery')
  // Recovery must work inside the production App with an existing, locked session.
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') != null && ${modelIs('model-1')}`)
  await click('textarea[aria-label="描述任务"]')
  await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
  await contents.insertText('Draft survives detection timeout')
  await wait(`document.querySelector('textarea').value === 'Draft survives detection timeout'`)
  await click('#fail-detection')
  const state = `JSON.parse(document.querySelector('#model-state').textContent)`
  await wait(`document.querySelector('.composer-retry-detection')?.disabled === false && document.querySelector('.send').disabled`)
  if (!await read(`document.querySelector('.clibtn').disabled && document.querySelector('.clibtn').dataset.agentId === 'claude'`)) throw new Error('Existing session runtime was not locked')
  await click('#hold-detection')
  const controlReads = await read(`${state}.controlRequests.length`)
  await click('.composer-retry-detection')
  await wait(`document.querySelector('.composer-retry-detection').disabled && ${state}.controlRequests.length === ${controlReads + 1}`)
  await click('#release-detection')
  await wait(`document.querySelector('.composer-retry-detection')?.disabled === false && document.querySelector('.send').disabled`)
  if (!await read(`document.querySelector('.composer-status').textContent.includes('fixture detection timeout')`)) throw new Error('Failed retry hid the detection error')
  await click('#recover-detection')
  await click('.composer-retry-detection')
  await wait(`document.querySelector('.composer-retry-detection') == null && !document.querySelector('.send').disabled && ${modelIs('model-1')}`)
  if (!await read(`document.querySelector('textarea').value === 'Draft survives detection timeout' && ${requests}.length === 3 && ${state}.controlRequests.at(-1).providerId === 'claude' && ${state}.controlRequests.at(-1).cwd === '/fixture'`)) throw new Error('Retry lost the draft/runtime/context or sent it automatically')
  // Queue the retained draft, then archive before it can drain after terminal.
  await click('.send')
  await wait(`document.querySelector('textarea').value === ''`)
  await click('[aria-label="存档会话：Conversation one"]')
  await wait(`document.querySelector('.run-status') == null && !document.querySelector('[aria-label="存档会话：Conversation one"]') && ${state}.stoppedRuns.includes('run-3')`)
  if (await read(`${requests}.length`) !== 3) throw new Error('Archiving current session drained its queue')
  await click('.sb-undo button')
  await wait(`document.querySelector('[aria-label="存档会话：Conversation one"]') != null`)
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') == null`)
  if (await read(`${requests}.length`) !== 3) throw new Error('Undo resumed archived execution')
  await send('Run for background archive')
  await wait(`${requests}.length === 4 && document.querySelector('.run-status') != null`)
  await send('Queued background message must not run')
  await wait(`document.querySelector('textarea').value === ''`)
  await pickSession('Conversation two')
  await wait(`document.querySelector('.run-status') == null`)
  await click('[aria-label="存档会话：Conversation one"]')
  await wait(`!document.querySelector('[aria-label="存档会话：Conversation one"]') && ${state}.stoppedRuns.includes('run-4')`)
  if (!await read(`${requests}.length === 4 && document.querySelector('.sb-sess[aria-current="true"]').textContent.includes('Conversation two')`)) throw new Error('Background archive changed selection or sent its queue')
  await click('.sb-undo button')
  await wait(`document.querySelector('[aria-label="存档会话：Conversation one"]') != null`)
  await pickSession('Conversation one')
  await wait(`document.querySelector('.run-status') == null && document.querySelector('.prompt-queue') == null`)
  if (await read(`${requests}.length`) !== 4) throw new Error('Background archive queue resumed after undo')
  await click('.sb-new')
  await wait(`document.querySelector('.clibtn').disabled === false`)
  await send('Provisional archive')
  await wait(`${requests}.length === 5 && document.querySelector('.run-status') != null`)
  await send('Queued provisional message must not run')
  await wait(`document.querySelector('textarea').value === ''`)
  await click('#hold-archive')
  await click('[aria-label="存档会话：Provisional archive"]')
  await wait(`${state}.stoppedRuns.includes('run-5')`)
  await pickSession('Conversation two')
  await wait(`document.querySelector('.sb-sess[aria-current="true"]')?.textContent.includes('Conversation two')`)
  await click('#release-archive')
  await wait(`document.querySelector('.sb-undo')?.textContent.includes('Provisional archive')`)
  if (!await read(`${requests}.length === 5 && document.querySelector('.sb-sess[aria-current="true"]').textContent.includes('Conversation two')`)) throw new Error('Late archive acknowledgment reset the newer selection or drained a provisional queue')
  if (screenshotPath) for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = '${theme}'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const bounds = await read(`(() => {
      const { x, y, width, height } = document.querySelector('.sb-nav').getBoundingClientRect()
      return { x: Math.round(x), y: Math.round(y), width: Math.ceil(width), height: Math.ceil(height) }
    })()`)
    const image = await contents.capturePage(bounds)
    require('node:fs').writeFileSync(screenshotPath + '-' + theme + '.png', image.toPNG())
  }
  return { retryDetection: { lockedSession: true, failedRetry: true, pendingDisabled: true, draftAndModelPreserved: true, originalContext: true, noAutoSend: true }, archive: { currentRunning: true, backgroundRunning: true, provisionalRun: true, selectionRace: true, queuesCancelled: true, undoDoesNotResume: true }, models: actual.map((request) => request.model.id), newDefault: 'model-2', effortIsolated: true, nativeCapture: true, backgroundTerminalCapture: true, queuedContinuation: true, persisted: true, legacyArchiveRestored: true, lazyInventory: { backgroundRequests: 0, skillsRequests: 3, mcpRequests: 3, providerAndProfileContext: true } }
}
