export async function exerciseMotionTokens(contents) {
  const check = (value, message) => { if (!value) throw new Error(`Motion tokens: ${message}`) }
  const read = expression => contents.executeJavaScript(expression)
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    throw new Error(`Motion tokens condition timed out: ${expression}`)
  }
  const point = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center', behavior: 'instant' })`)
    return read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
  }
  const hover = async selector => {
    const position = await point(selector)
    contents.sendInputEvent({ type: 'mouseMove', ...position })
    await wait(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`)
  }
  const transform = selector => read(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).transform`)
  const checkNoTransform = async (selector, label) => {
    check(await transform(selector) === 'none', `${label} moved on hover/focus`)
  }

  await wait('window.motionFixture && document.querySelector(".tool-group-row") && document.querySelector(".send")')
  const toolGroup = await point('.tool-group-row')
  contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...toolGroup })
  contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...toolGroup })
  await wait('document.querySelector(".tool-card") != null')
  // This fixture measures hover, not Step04's newly mounted 240ms disclosure.
  await read(`Promise.all(document.querySelector('#motion-tool').getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
  check(await read("getComputedStyle(document.documentElement).getPropertyValue('--dur-slow').trim() === '300ms'"), 'the slow token is not 300ms')
  check(await read("getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() === 'cubic-bezier(0.23, 1, 0.32, 1)'"), 'the shared ease-out token is missing')

  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = '${theme}'`)
    await hover('.tool-card')
    await checkNoTransform('.tool-card', `${theme} tool card`)
    await hover('.send')
    await checkNoTransform('.send', `${theme} send button`)
    await hover('#motion-sidebar .sb-sess')
    await checkNoTransform('#motion-sidebar .sb-sess', `${theme} activity row`)
    await hover('#motion-analysis .overview-metric')
    await checkNoTransform('#motion-analysis .overview-metric', `${theme} analysis metric`)
  }

  for (const selector of ['.tool-card .tool-row', '.send', '#motion-sidebar .sb-sess', '#motion-analysis button']) {
    await read(`document.querySelector(${JSON.stringify(selector)})?.focus()`)
    await checkNoTransform(selector, selector)
  }

  await contents.debugger.attach('1.3')
  try {
    // Exercise both motion modes explicitly rather than inheriting the runner's
    // OS preference; a runner that reports reduced motion skips every FLIP.
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    })
    await wait("!matchMedia('(prefers-reduced-motion: reduce)').matches")
    await read('window.motionFixture.reorder()')
    await wait(`document.querySelector('[data-motion-key="motion-session"]').dataset.activityGroup === 'attention'`)
    const normal = await read(`document.querySelector('.sb-activity').getAnimations({ subtree: true })
      .filter(animation => animation.effect?.target?.hasAttribute('data-motion-key'))
      .map(animation => ({ duration: animation.effect.getTiming().duration, frames: animation.effect.getKeyframes() }))`)
    check(normal.some(animation => animation.duration === 300 && animation.frames.some(frame => frame.transform != null)), 'normal reorder did not produce the 300ms FLIP positive control')

    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    await wait("matchMedia('(prefers-reduced-motion: reduce)').matches")
    await read('window.motionFixture.reorder()')
    await wait(`document.querySelector('[data-motion-key="motion-session"]').dataset.activityGroup === 'working'`)
    const reduced = await read(`(() => {
      const row = document.querySelector('[data-motion-key="motion-session"] .sb-sess')
      const activity = document.querySelector('.sb-activity')
      const keyframes = animation => animation.effect?.getKeyframes?.() ?? []
      const layoutAnimations = activity.getAnimations({ subtree: true }).filter(animation =>
        animation.effect?.target?.hasAttribute('data-motion-key') && keyframes(animation).some(frame => frame.transform != null)
      )
      const style = getComputedStyle(row)
      return {
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        group: row.closest('[data-activity-group]')?.getAttribute('data-activity-group'),
        layoutAnimations: layoutAnimations.length,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionTimingFunction: style.transitionTimingFunction
      }
    })()`)
    check(reduced.reduced && reduced.group === 'working', `reduced-motion reorder did not commit: ${JSON.stringify(reduced)}`)
    check(reduced.layoutAnimations === 0, `reduced-motion reorder still animates transforms: ${JSON.stringify(reduced)}`)
    // Isolate the next background-color change from the preceding theme switch.
    // Keep the assertions below about newly created transitions unchanged.
    await read(`Promise.all([...document.querySelectorAll('#motion-instant, #motion-none, #motion-sidebar .sb-sess-row, #motion-sidebar .sb-sesstext, #motion-micro')].flatMap(node => node.getAnimations().map(animation => animation.finished)))`)
    const colorChanges = await read(`(() => {
      const selectors = ['#motion-instant', '#motion-none', '#motion-sidebar .sb-sess-row', '#motion-sidebar .sb-sesstext', '#motion-micro']
      return selectors.map(selector => {
        const node = document.querySelector(selector)
        getComputedStyle(node).backgroundColor
        node.style.backgroundColor = 'rgb(20, 40, 60)'
        getComputedStyle(node).backgroundColor
        return { selector, animations: node.getAnimations().map(animation => ({
          property: animation.transitionProperty,
          duration: animation.effect.getTiming().duration,
          easing: animation.effect.getTiming().easing
        })) }
      })
    })()`)
    for (const entry of colorChanges.slice(0, -1)) {
      check(entry.animations.length === 0, `reduced motion added an undeclared color transition: ${JSON.stringify(entry)}`)
    }
    const micro = colorChanges.at(-1)
    check(micro.animations.length === 1 && micro.animations[0].property === 'background-color' &&
      micro.animations[0].duration > 0 && micro.animations[0].duration <= 100 && micro.animations[0].easing === 'linear',
    `the declared micro color transition changed: ${JSON.stringify(micro)}`)
  } finally {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
    contents.debugger.detach()
  }

  return {
    cssTokens: true,
    themes: ['dark', 'light'],
    hoverStates: ['tool-card', 'composer-send', 'sidebar-activity', 'analysis'],
    focusStates: true,
    reducedMotionReorder: true,
    reducedMotionColorTransition: 'declared duration, at most 100ms linear',
    noUndeclaredColorTransitions: true,
    reducedMotionTransformAnimation: false
  }
}

// The production App uses its existing synthetic smoke adapter in a temporary HOME/workspace.
export async function exerciseMotionApp(cdp, evaluate) {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const captures = mkdtempSync(join(tmpdir(), 'scry-motion-app-'))
  const wait = async expression => evaluate(`(async () => {
    const deadline = Date.now() + 15000;
    while (!(${expression})) {
      if (Date.now() > deadline) throw new Error('Motion App state timed out: ' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`)
  const point = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    return evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      if (!node.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Occluded motion target: ' + ${JSON.stringify(selector)});
      return point;
    })()`)
  }
  const click = async selector => {
    const position = await point(selector)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position })
  }
  const hover = async selector => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(selector) })
    await wait(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`)
    if (await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).transform`) !== 'none') {
      throw new Error(`Motion App target moved: ${selector}`)
    }
  }
  const capture = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(captures, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  await click('button.sb-sess')
  await click('.sb-new')
  await click('.runtime-composer textarea')
  await cdp.send('Input.insertText', { text: 'motion foundation smoke' })
  await wait('document.querySelector(".send")?.disabled === false')
  await click('.send')
  await wait('document.querySelector(".tool-group-row") != null && document.querySelector(".stop") == null')
  await click('.runtime-composer textarea')
  await cdp.send('Input.insertText', { text: 'unsent motion draft' })
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`)
    await click('.tool-group-row')
    await wait('document.querySelector(".chat-body .tool-card") != null')
    await hover('button.sb-sess')
    await hover('.chat-body .tool-card')
    await hover('.runtime-composer .send')
    await capture(`${theme}-chat`)
    await click('.sb-nav .sb-navitem:first-child')
    await wait('document.querySelector(".usage-page .usage-refresh") != null')
    await hover('.usage-refresh')
    await capture(`${theme}-analytics`)
    await click('button.sb-sess')
    await wait('document.querySelector(".runtime-composer .send")?.disabled === false && document.querySelector(".runtime-composer textarea")?.value === "unsent motion draft"')
  }
  return { test: 'motion foundation production App', themes: ['dark', 'light'], nativeSend: true,
    unsentDraftRetained: true, hoverNoDisplacement: ['sidebar', 'tool-card', 'composer', 'analytics'], captures }
}
