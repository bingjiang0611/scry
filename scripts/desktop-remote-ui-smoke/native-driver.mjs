export function createNativeDriver(contents, pointer, capture) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression, label = expression) => {
    const deadline = Date.now() + 7000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}; DOM=${await read('JSON.stringify({ focus: document.activeElement?.tagName, selects: [...document.querySelectorAll("select")].map(node => ({value:node.value, options:[...node.options].map(option => ({text:option.text, value:option.value}))})), text: document.body.innerText.slice(-2000), events: window.desktopRemoteFixture.uiEvents })')}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const pointFor = (selector, text, captureReceipt = false) => read(`(${pointer.toString()})(${JSON.stringify(selector)}, { text: ${JSON.stringify(text ?? '')}, timeoutMs: 7000, scroll: true, captureReceipt: ${captureReceipt} })`)
  const send = (method, params) => contents.debugger.sendCommand(method, params)
  const click = async (selector, text) => {
    const point = await pointFor(selector, text, true)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await wait('window.__nativeUiPointerReceipt != null', 'native pointer receipt')
    const receipt = await read('window.__nativeUiPointerReceipt')
    check(receipt.trusted && receipt.targetMatched, `Native pointer missed ${selector}: ${JSON.stringify(receipt)}`)
  }
  const key = async (key, code = key, modifiers = 0) => {
    const virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Backspace' ? 8 : key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? 38 : key.length === 1 ? (key.charCodeAt(0) < 128 ? key.toUpperCase().charCodeAt(0) : 0) : undefined
    const nativeVirtualKeyCode = process.platform === 'darwin'
      ? { Enter: 36, Escape: 53, Backspace: 51, ArrowDown: 125, ArrowUp: 126, b: 11, f: 3 }[key]
      : virtualKey
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    if (key.length === 1) await send('Input.dispatchKeyEvent', { type: 'char', key, text: key, unmodifiedText: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode, modifiers })
  }
  const insert = (text) => send('Input.insertText', { text })
  const pasteImage = async () => read(`(async () => { const input = document.querySelector('textarea[aria-label="描述任务"]'); const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2; const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); const transfer = new DataTransfer(); transfer.items.add(new File([png], 'pasted.png', { type: 'image/png' })); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })); return true })()`)
  const formEnter = async () => {
    const event = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: process.platform === 'darwin' ? 36 : 13 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  const fixture = () => read('window.desktopRemoteFixture')
  const bodyText = () => read('document.body.textContent')
  return { contents, capture, check, read, wait, pointFor, send, click, key, insert, pasteImage, formEnter, fixture, bodyText,
    remoteShown: 'document.querySelector(".execution-location.is-remote") != null',
    sendDisabled: 'document.querySelector(".runtime-composer button.send").disabled',
    composerValue: 'document.querySelector(\'textarea[aria-label="描述任务"]\').value' }
}
