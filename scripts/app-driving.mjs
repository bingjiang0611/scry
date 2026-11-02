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
  /**
   * Real pointer target, proven clickable before the mouse moves.
   *
   * `elementFromPoint` alone is not enough: it samples one instant, and the recovery
   * banners this suite clicks are re-rendered by refreshes, so a rect taken before the
   * last re-render lands on whatever moved under the cursor. The precondition is
   * observable — same rect on two consecutive frames, visible, enabled, hit-tested — and
   * its failure carries the evidence needed to tell "wrong element matched" (a global
   * selector hitting another pane) from "covered" (an overlay), from "moved" (layout).
   * No sleeping, no second click attempt: a target that is not clickable fails here.
   */
  const clickableAt = (expression, selector, timeoutMs = 20000) => evaluate(`(async () => {
    const find = () => (${expression});
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const describe = node => node === null || node === undefined ? null
      : { tag: node.tagName, cls: node.className?.toString().slice(0, 80) ?? null,
        text: (node.textContent ?? '').trim().slice(0, 60),
        ownerConversation: node.closest('[data-conversation-id]')?.dataset.conversationId ?? null,
        ownerSideChat: node.closest('[data-side-chat-id]')?.dataset.sideChatId ?? null,
        ownerPane: node.closest('#main-pane, #side-pane, [data-pane]')?.id ?? null };
    const evidence = () => ({ target: describe(node), matches: matches.length, candidates: matches.map(describe),
      disabled: node?.disabled ?? null, rect: rect ?? null,
      stack: point ? document.elementsFromPoint(point.x, point.y).slice(0, 4).map(describe) : [] });
    let node = null; let matches = []; let rect = null; let point = null; let previous = null;
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      if (!node || !node.isConnected) {
        node = find();
        matches = node === null || node === undefined ? []
          : ${JSON.stringify(selector ?? null)} === null ? [node]
            : [...document.querySelectorAll(${JSON.stringify(selector ?? '')})];
      }
      if (!node) { previous = null; await frame(); continue; }
      node.scrollIntoView({ block: 'nearest' });
      rect = node.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && (node.checkVisibility?.() ?? true);
      point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      const stable = previous !== null && previous.x === rect.x && previous.y === rect.y
        && previous.width === rect.width && previous.height === rect.height;
      previous = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const ok = visible && !node.disabled && stable && hit !== null && node.contains(hit);
      if (ok) return { point, evidence: evidence() };
      await frame();
    }
    throw new Error('Unclickable target ' + ${JSON.stringify(expression.slice(0, 120))} + ' ' + JSON.stringify(evidence()));
  })()`).catch((error) => { throw new Error(`${label} pointer: ${error.message}`) })
  const pointFor = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    return (await clickableAt(`document.querySelector(${JSON.stringify(selector)})`, selector)).point
  }
  /** Same real pointer, for a target that has no stable selector of its own. */
  const pointerAt = expression => clickableAt(expression, null).then(result => result.point)
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
