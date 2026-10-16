// Used by the existing isolated Electron UI runner, including the normal macOS gate.
export async function exerciseMetaPrompts(contents, win, clipboard, screenshotPrefix) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = async expression => {
    const result = await contents.executeJavaScript(expression)
    return result
  }
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    const state = await read(`({ body: document.querySelector('.mp-body')?.textContent, editorBody: document.querySelector('.mp-editor-modal textarea')?.value, search: document.querySelector('.mp-search input')?.value, storage: localStorage.getItem('scry.meta-prompts.v1'), notice: document.querySelector('.mp-notice')?.textContent })`)
    throw new Error(`Meta Prompts DOM condition timed out: ${expression.slice(0, 160)}; state=${JSON.stringify(state)}`)
  }
  const click = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      const r = node.getBoundingClientRect();
      const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Control is obscured: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const type = async (selector, text) => {
    await click(selector)
    const field = `document.querySelector(${JSON.stringify(selector)})`
    await wait(`${field} === document.activeElement`)
    // Native click/edit commands are asynchronous. Do not let a late Backspace
    // erase newly inserted text, or send insertion to the previously focused field.
    if (await read(`${field}.value.length > 0`)) {
      contents.selectAll()
      await wait(`${field}.selectionStart === 0 && ${field}.selectionEnd === ${field}.value.length`)
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      await wait(`${field}.value === ''`)
    }
    await contents.insertText(text)
    await wait(`${field}.value === ${JSON.stringify(text)}`)
  }
  // Regression: a native click may select the textarea before ModalFrame's first
  // animation frame. That frame must not steal focus back to the title input.
  const openNew = async () => {
    await read('window.__holdModalFrame()')
    await click('.mp-header .mp-button:not(.mp-back)')
    await wait(`document.querySelector('.mp-editor-modal input') === document.activeElement`)
    await click('.mp-editor-modal textarea')
    await wait(`document.querySelector('.mp-editor-modal textarea') === document.activeElement`)
    await read('window.__releaseModalFrame()')
    check(await read(`document.activeElement === document.querySelector('.mp-editor-modal textarea')`), 'Modal frame stole native textarea focus after its first frame')
  }
  const save = async () => {
    await click('.mp-editor-modal button[type="submit"]')
    await wait(`!document.querySelector('.mp-editor-modal')`)
  }
  const title = '先写方案，再开始实现'
  const body = '  先不要修改代码。\n\n<script>literal only</script>\n\n' + '检查调用链，给出最小方案与验证依据。\n'.repeat(45)
  await wait(`document.querySelector('.mp-detail-empty') && document.querySelector('.mp-header')`)
  check(await read(`!document.body.textContent.includes('收藏')`), 'Favorites must not appear')
  check(await read(`document.querySelector('[aria-label="主要视图"]').textContent.indexOf('MCP') < document.querySelector('[aria-label="主要视图"]').textContent.indexOf('Meta Prompts')`), 'Entry is not below MCP')
  await openNew()
  check(await read(`document.querySelector('.mp-editor-modal button[type="submit"]').disabled`), 'Empty prompts must not be saved')
  await type('.mp-editor-modal input', title)
  await type('.mp-editor-modal textarea', body)
  await wait(`document.querySelector('.mp-editor-modal textarea')?.value === ${JSON.stringify(body)}`)
  await save()
  await wait(`document.querySelector('.mp-body')?.textContent === ${JSON.stringify(body)}`)
  check(await read(`document.querySelector('.mp-body script') === null`), 'Prompt markup was executed or rendered as HTML')
  check(await read(`JSON.parse(localStorage.getItem('scry.meta-prompts.v1'))[0].body === ${JSON.stringify(body)}`), 'Save did not persist exact body')
  await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload() })
  await wait(`document.querySelector('.mp-body')?.textContent === ${JSON.stringify(body)}`)

  await type('.mp-search input', 'literal')
  await wait(`document.querySelectorAll('.mp-row').length === 1`)
  await type('.mp-search input', 'not found')
  await wait(`document.querySelectorAll('.mp-row').length === 0 && document.querySelector('.mp-detail-empty')`)
  await type('.mp-search input', '')
  await wait(`document.querySelector('.mp-body')?.textContent === ${JSON.stringify(body)}`)
  await click('.mp-primary')
  await wait(`document.querySelector('[role="status"]')?.textContent.includes('已复制')`)
  check(clipboard.readText() === body, 'Copied text differs from the saved body')

  await click('[aria-label="编辑提示词"]')
  await type('.mp-editor-modal textarea', '未保存的修改')
  await click('[aria-label="关闭提示词编辑器"]')
  await wait(`document.querySelector('.mp-discard')`)
  await click('.mp-discard .mp-danger')
  await wait(`!document.querySelector('.mp-editor-modal')`)
  check(await read(`document.querySelector('.mp-body').textContent === ${JSON.stringify(body)}`), 'Discard changed persisted body')

  await click('[aria-label="编辑提示词"]')
  await type('.mp-editor-modal input', '先写方案，再开始实现（修订）')
  await save()
  await wait(`document.querySelector('.mp-detail h2')?.textContent.includes('修订')`)
  if (screenshotPrefix) {
    await wait(`!document.querySelector('.mp-notice')`)
    for (const theme of ['dark', 'light']) {
      await read(`document.documentElement.dataset.theme = '${theme}'`)
      await read(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      require('node:fs').writeFileSync(screenshotPrefix + '-' + theme + '.png', (await contents.capturePage()).toPNG())
    }
    win.hide()
  }
  await click('.mp-detail-footer .mp-button:not(.mp-primary)')
  await wait(`document.querySelector('[aria-label="当前草稿"]')`)
  check(await read(`document.querySelector('[aria-label="当前草稿"]').value === ${JSON.stringify('原有任务，不要覆盖\n\n' + body)}`), 'Insert overwrote the existing draft or altered text')
  check(await read(`document.querySelector('#meta-fixture').dataset.sends === '0'`), 'Insert unexpectedly sent a message')
  await click('.sb-navitem:last-child')
  await wait(`document.querySelector('.mp-body')`)
  await click('[aria-label="删除提示词"]')
  await wait(`document.querySelector('.mp-delete-modal')`)
  await click('.mp-delete-modal .mp-danger')
  await wait(`document.querySelector('.mp-detail-empty') && document.querySelectorAll('.mp-row').length === 0`)
  check(await read(`localStorage.getItem('scry.meta-prompts.v1') === '[]'`), 'Deletion was not saved')
  await read(`localStorage.setItem('scry.meta-prompts.v1', '{broken')`)
  await new Promise(resolve => { contents.once('did-finish-load', resolve); contents.reload() })
  await wait(`document.querySelector('.mp-load-error')`)
  check(await read(`document.querySelector('.mp-header .mp-button:not(.mp-back)').disabled && localStorage.getItem('scry.meta-prompts.v1') === '{broken'`), 'Corrupt data was overwritten or allowed editing')
  return { nativeCoordinateActions: true, storageReload: true, plainText: true, search: true, clipboardExact: true, discard: true, edit: true, draftPreserved: true, notSent: true, deletion: true, corruptDataProtected: true }
}

// Full App wiring, with its real main/preload and an isolated smoke Provider.
export async function exerciseMetaPromptsApp(cdp, evaluate) {
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    throw new Error(`Full App Meta Prompts condition timed out: ${expression}`)
  }
  const click = async selector => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing App control: ' + ${JSON.stringify(selector)});
      const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('App control obscured');
      return { x, y };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const body = '完整 App 回归：保留草稿，不发送。\n\n纯文本提示词。'
  const draft = '原有草稿'
  await wait(`document.querySelector('textarea[aria-label="描述任务"]') && Array.from(document.querySelectorAll('.sb-navitem')).some(node => node.textContent.includes('Meta Prompts'))`)
  await click('textarea[aria-label="描述任务"]')
  await cdp.send('Input.insertText', { text: draft })
  await wait(`document.querySelector('textarea[aria-label="描述任务"]').value === ${JSON.stringify(draft)}`)
  await click('.sb-navitem:last-child')
  await wait(`document.querySelector('.mp-detail-empty')`)
  await click('.mp-header .mp-button:not(.mp-back)')
  await wait(`document.querySelector('.mp-editor-modal input') === document.activeElement`)
  await cdp.send('Input.insertText', { text: '真实 App 接线检查' })
  await click('.mp-editor-modal textarea')
  await cdp.send('Input.insertText', { text: body })
  await click('.mp-editor-modal button[type="submit"]')
  await wait(`document.querySelector('.mp-body')?.textContent === ${JSON.stringify(body)}`)
  await click('.mp-detail-footer .mp-primary')
  await wait(`document.querySelector('[role="status"]')?.textContent.includes('已复制')`)
  await click('.mp-detail-footer .mp-button:not(.mp-primary)')
  await wait(`document.querySelector('textarea[aria-label="描述任务"]')?.value === ${JSON.stringify(draft + '\n\n' + body)}`)
  const runs = await evaluate('window.scry.activeRuns()')
  if (runs.length !== 0) throw new Error('Inserting a prompt started a Provider')
  await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
  return { body, appNavigation: true, nativeClipboardReceipt: true, selectedDraftPreserved: true, noProviderStarted: true, composerFocused: true }
}
