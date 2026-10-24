export async function exercisePiPermission(contents, scenario) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Pi ${scenario}: timed out: ${expression}; ${await read('document.body.innerText')}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing permission control');
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Permission control obscured');
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const enter = () => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  }
  const state = `JSON.parse(document.querySelector('#permission-state').textContent)`
  await wait(`${state}.pending === 1 && document.querySelector('.clibtn')?.textContent.includes('Rotom')`)
  contents.focus()
  await click('textarea[aria-label="描述任务"]')
  // Native mouse dispatch is asynchronous; insertion must wait for observable editable focus.
  await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
  await contents.insertText('Pi permission regression')
  await wait(`document.querySelector('textarea').value === 'Pi permission regression'`)
  if (!await read(`document.querySelector('.send').disabled`)) throw new Error(`Pi ${scenario}: loading catalog allowed send`)
  enter()
  await wait(`${state}.enterReceipts === 1`)
  if (await read(`${state}.requests.length`) !== 0) throw new Error('Pi default request escaped while loading')
  if (await read(`document.querySelector('textarea').value`) !== 'Pi permission regression') throw new Error('Blocked send lost draft')
  await click('#resolve-permissions')
  await wait(`${state}.pending === 0 && !document.querySelector('[aria-label="选择 Model 与 Effort"]').disabled`)
  // The user now requires the sole supported permission to be selected. Loading
  // still blocks send; a fresh catalog is not treated as ready before it arrives.
  await wait(`!document.querySelector('.send').disabled && document.querySelector('[aria-label="权限"]').textContent.includes('本机完全访问')`)
  if (scenario === 'fresh') await click('.send')
  else { await click('textarea[aria-label="描述任务"]'); enter() }
  await wait(`${state}.requests.length === 1`)
  const [request] = await read(`${state}.requests`)
  if (request.providerId !== 'pi' || request.agentProfileId !== 'pi:rotom' || request.permissionMode !== 'full_access' || request.prompt !== 'Pi permission regression') {
    throw new Error(`Pi ${scenario}: wrong start payload: ${JSON.stringify(request)}`)
  }
  return { scenario, loadingBlocked: true, permissionSelection: scenario === 'fresh' ? 'sole-supported' : 'restored', submittedPermission: request.permissionMode }
}
