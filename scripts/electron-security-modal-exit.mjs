import assert from 'node:assert/strict'

export async function verifyNativeModalExit(cdp, evaluate, selector, trigger) {
  await evaluate(`{
    const node = document.querySelector(${JSON.stringify(selector)}).closest('.modal-overlay');
    const exit = window.__smokeModalExit = {};
    node.addEventListener('animationstart', event => {
      if (event.target === node && event.animationName === 'modal-backdrop-out') exit.animationStart = performance.now();
    });
    node.addEventListener('animationend', event => {
      if (event.target === node && event.animationName === 'modal-backdrop-out') exit.animationEnd = performance.now();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && event.isTrusted) exit.start = performance.now();
    }, { once: true, capture: true });
    const observer = new MutationObserver(() => {
      if (!node.isConnected) { exit.end = performance.now(); observer.disconnect(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }`)
  const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...escape })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape })
  const exited = await evaluate(`(() => {
    const overlay = document.querySelector(${JSON.stringify(selector)})?.closest('.modal-overlay');
    return overlay?.dataset.state === 'exit' && overlay.inert &&
      document.activeElement === document.querySelector(${JSON.stringify(trigger)});
  })()`)
  assert.equal(exited, true, `Modal did not immediately retire interaction and restore trigger focus: ${selector}`)
  // The real hidden window needs a compositor paint to start the native animation.
  await cdp.send('Page.captureScreenshot', { format: 'png' })
  const exit = await evaluate(`(async () => {
    const exit = window.__smokeModalExit;
    const deadline = performance.now() + 1000;
    while (exit.end == null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    delete window.__smokeModalExit;
    const elapsed = time => time == null || exit.start == null ? null : time - exit.start;
    return {
      removed: document.querySelector(${JSON.stringify(selector)}) === null,
      ms: elapsed(exit.end), animationStartMs: elapsed(exit.animationStart), animationEndMs: elapsed(exit.animationEnd)
    };
  })()`)
  const clock = JSON.stringify({ selector, ...exit })
  assert.ok(exit.removed && Number.isFinite(exit.ms) && exit.ms <= 250, `Modal DOM exit exceeded the Step03 limit: ${clock}`)
  const complete = Number.isFinite(exit.animationStartMs) && Number.isFinite(exit.animationEndMs) &&
    exit.animationStartMs >= 0 && exit.animationEndMs > exit.animationStartMs && exit.animationEndMs <= exit.ms
  assert.ok(complete, `Modal DOM exited without a complete native animation: ${clock}`)
  return { ...exit, nativeAnimationEnd: true }
}
