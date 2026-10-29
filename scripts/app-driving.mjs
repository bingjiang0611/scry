import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Shared real-pointer driver for the isolated production App.
 *
 * Clicks are dispatched as Chromium mouse events at the target's own coordinates and the
 * hit is verified with `elementFromPoint`, so a test cannot pass by calling `.click()` on
 * an occluded or non-interactive node. Captures go to one temporary directory per run.
 */
export function createAppDriver({ cdp, evaluate, label = 'App' }) {
  const captures = mkdtempSync(join(tmpdir(), 'scry-app-driver-'))
  const wait = (expression, timeoutMs = 20000) => evaluate(`(async () => { const deadline = Date.now() + ${timeoutMs}; while (!(${expression})) { if (Date.now() > deadline) throw new Error(${JSON.stringify(`${label} state: `)} + ${JSON.stringify(expression)}); await new Promise(resolve => setTimeout(resolve, 25)); } })()`)
  const pointFor = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    return evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest' });
      const r = node.getBoundingClientRect();
      const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      const hit = document.elementFromPoint(p.x, p.y);
      if (!node.contains(hit)) throw new Error('Occluded target: ' + JSON.stringify({ selector: ${JSON.stringify(selector)}, hit: hit?.outerHTML.slice(0, 400) }));
      return p;
    })()`).catch((error) => { throw new Error(`[click ${selector}] ${error.message}`) })
  }
  /** Same real pointer, for a target that has no stable selector of its own. */
  const pointerAt = expression => evaluate(`(() => {
    const node = (${expression});
    if (!node) throw new Error('Missing target: ' + ${JSON.stringify(expression.slice(0, 160))});
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const hit = document.elementFromPoint(p.x, p.y);
    if (!node.contains(hit)) throw new Error('Occluded target: ' + (hit?.outerHTML?.slice(0, 400) ?? 'null'));
    return p;
  })()`)
  const clickAt = async expression => {
    const point = await pointerAt(expression)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const click = async selector => {
    const point = await pointFor(selector)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const mouseClick = async (clickCount, point) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...point })
  }
  const keyStroke = async ({ key, code = key, windowsVirtualKeyCode, modifiers = 0 }) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode, modifiers })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  const key = async (key, code = key) => {
    await keyStroke({ key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 })
  }
  const capture = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(captures, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const idle = () => wait(`!document.getAnimations().find(a => a.id === 'scry-structure') && document.getAnimations().filter(a => a.id === 'scry-pane').length === 0`)
  return { captures, wait, pointFor, pointerAt, clickAt, click, mouseClick, key, keyStroke, capture, idle }
}
