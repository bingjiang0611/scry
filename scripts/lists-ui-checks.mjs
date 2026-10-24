// Production components, compositor frames and native input; no programmatic clicks.
export async function exerciseLists(contents, win, screenshotPrefix = '', pointerSource, campaign, exerciseStructure) {
  const read = expression => contents.executeJavaScript(expression)
  const check = (value, message) => { if (!value) throw new Error(`Lists: ${message}`) }
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() >= deadline) throw new Error(`Lists condition timed out: ${expression}`)
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  }
  const click = async selector => {
    const point = await read(`(${pointerSource})(${JSON.stringify(selector)}, { timeoutMs: 5000, scroll: true, captureReceipt: true })`)
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  }
  const settle = async () => read(`Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations !== Infinity).map(a=>a.finished.catch(()=>{})))`)
  const arm = async predicate => read(`(() => {
    window.__listObserver?.disconnect(); window.__listCapture=null;
    const sample=()=>{
      const animations=document.getAnimations().filter(a=>{const node=a.effect?.target;return node instanceof Element && (${predicate})});
      if(!animations.length)return;
      window.__listCapture=animations.map(a=>({name:a.animationName??a.id,duration:a.effect.getTiming().duration,delay:a.effect.getTiming().delay,
        key:a.effect.target.getAttribute('data-motion-key'),className:a.effect.target.className,
        tag:a.effect.target.tagName,frames:a.effect.getKeyframes(),
        toolCount:a.effect.target.matches('.tool-card')?1:a.effect.target.querySelectorAll('.tool-card').length,
        added:a.effect.target.textContent.includes('added.ts')}));
      window.__listObserver.disconnect();
    };
    window.__listSample=sample;
    window.__listObserver=new MutationObserver(sample);
    window.__listObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','data-state','aria-selected','open']});
  })()`)
  const captured = async () => { await wait('(window.__listSample(), window.__listCapture !== null)'); return read('window.__listCapture') }
  const screenshot = async name => {
    if (!screenshotPrefix) return
    const { writeFile } = require('node:fs/promises')
    await writeFile(`${screenshotPrefix}-${name}.png`, (await contents.capturePage()).toPNG())
  }
  const opacityOnly = animations => animations.every(animation => animation.frames.every(frame => !('transform' in frame) && !('height' in frame) && !('gridTemplateRows' in frame)))
  await wait("document.querySelector('#list-sidebar .sb-proj-head') && document.querySelector('.surface-tabs [role=tab]')")
  const expandTools = async count => {
    await wait("document.querySelector('.tool-group-row') || document.querySelector('.tool-card')")
    for (let index=0; index<50 && await read("!!document.querySelector('.tool-group:not(.open) .tool-group-row')"); index++) {
      const id = await read("document.querySelector('.tool-group:not(.open) .tool-group-row').getAttribute('aria-controls')")
      const selector = `[aria-controls=${JSON.stringify(id)}]`
      await click(selector)
      await wait(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')==='true'`)
      await settle()
    }
    await wait(`document.querySelectorAll('.tool-card').length===${count}`)
  }
  const attachLive = async () => {
    const previous = await read("document.querySelector('[data-run-id]')?.dataset.runId")
    await click('#list-live')
    await wait(`document.querySelector('[data-run-id]')?.dataset.runId !== ${JSON.stringify(previous)} && document.querySelector('[data-run-id]')?.dataset.runId.startsWith('live-')`)
    await expandTools(2)
  }
  win.setSize(1400, 900)
  if (campaign === 'refs') {
    await wait("window.listFixture.turnRefs.size===1")
    const runId = await read("[...window.listFixture.turnRefs.keys()][0]")
    await read("window.__referenceNode=[...window.listFixture.turnRefs.values()][0]; window.listFixture.referenceScope('shared-fork', true)")
    await wait("document.querySelector('[data-loading-previous=true]')?.inert===true")
    check(await read("window.__referenceNode.isConnected && window.listFixture.turnRefs.size===0 && window.listFixture.refEvents.at(-1).attached===false"), 'retained transcript remained registered for turn navigation')
    await wait("document.querySelector('.chat-body > .loading-status')")
    check(await read("window.listFixture.turnRefs.size===0"), 'fading transcript re-registered its old turn reference')
    await read("window.listFixture.referenceScope('shared-fork', false)")
    await wait(`window.listFixture.turnRefs.has(${JSON.stringify(runId)})`)
    check(await read(`window.listFixture.turnRefs.get(${JSON.stringify(runId)})===document.querySelector('[data-run-id]') && !document.querySelector('[data-loading-previous=true]') && window.listFixture.refEvents.at(-1).attached===true`), 'ready fork with a shared runId did not register its current turn')
    return { retainedTurnRefsRetired: true, readySharedRunIdRegistered: true }
  }
  if (campaign === 'structure') return exerciseStructure({ read, check, wait, click, settle, arm, captured, screenshot, contents })
  if (campaign === 'history') {
    await click('#list-analytics')
    await wait("document.querySelector('.usage-state')")
    await read(`(() => {
      window.__historicalEntry = false
      const sample = () => {
        window.__historicalEntry ||= document.getAnimations().some(animation => animation.effect.getTiming().duration === 180 && (animation.effect.target.matches('.tool-card, .turn-tail') || animation.effect.target.querySelector('.tool-card')))
        window.__historyFrame = requestAnimationFrame(sample)
      }
      window.__historyFrame = requestAnimationFrame(sample)
    })()`)
    await click('#list-history')
    await wait("document.querySelector('.si-head') && document.querySelector('.thinking')")
    await arm("node.classList.contains('motion-disclosure') && !!node.querySelector('.si-body')")
    await click('.si-head')
    check((await captured()).some(a=>a.duration===240 && a.frames.some(frame=>'gridTemplateRows' in frame)), 'short skill did not use the 240ms grid entrance')
    await settle(); await click('.si-head'); await wait("!document.querySelector('.si-body')")
    await click('.think-head'); await wait("!document.querySelector('.think-text')")
    // Sample the native pseudo-box itself; do not assume UA content appears as
    // an Element target in document.getAnimations().
    await read(`(() => {
      window.__detailsFrames = []
      window.__detailsDone = false
      const node = document.querySelector('.thinking')
      const sample = time => {
        const style = getComputedStyle(node, '::details-content')
        window.__detailsFrames.push({ time, height: parseFloat(style.height), opacity: parseFloat(style.opacity), duration: style.transitionDuration })
        if (node.open && style.opacity === '1') window.__detailsDone = true
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })()`)
    await click('.think-head')
    await wait('window.__detailsDone')
    const detailsFrames = await read('window.__detailsFrames')
    check(detailsFrames.some(frame=>frame.opacity>0 && frame.opacity<1) && new Set(detailsFrames.map(frame=>frame.height)).size>=3, `native details did not interpolate height/opacity: ${JSON.stringify(detailsFrames)}`)
    check(detailsFrames.at(-1).duration.split(',').every(value=>Math.abs(parseFloat(value)*1000-240)<1e-6), 'native details duration was not 240ms')
    await settle()
    // Native disclosure opening must not turn old cards into live arrivals.
    await expandTools(50)
    const longTool = `[aria-controls=${JSON.stringify(await read("[...document.querySelectorAll('.tool-card .tool-row')].at(-1).getAttribute('aria-controls')"))}]`
    await arm("node.classList.contains('motion-disclosure') && !!node.querySelector('.tool-detail-region')")
    await click(longTool)
    const longMotion = await captured()
    check(longMotion.every(a=>a.duration===160) && opacityOnly(longMotion), `long output animated height: ${JSON.stringify(longMotion)}`)
    await settle(); await click(longTool); await wait("!document.querySelector('.tool-detail-region')")
    check(await read("!document.getAnimations().some(a=>a.effect.getTiming().duration===180 && (a.effect.target.matches('.tool-card, .turn-tail')||a.effect.target.querySelector('.tool-card')))"), 'history cards or known metrics animated')
    await read('cancelAnimationFrame(window.__historyFrame)')
    check(await read('!window.__historicalEntry'), 'historical tools or known metrics entered while disclosures opened')
    return { history50NoEntry: true, shortGridAndNativeDetails240: true, longOutputOpacityOnly160: true }
  }
  await attachLive()
  await settle()
  await arm("a.effect.getTiming().duration===180 && (node.matches('.tool-card')||node.querySelector('.tool-card'))")
  await click('#list-tool')
  const arrival = await captured()
  check(arrival.length===1 && arrival[0].duration===180 && arrival[0].toolCount===1 && arrival[0].added, `only appended tool may enter: ${JSON.stringify(arrival)}`)
  await read("window.__toolEntrance=document.getAnimations().find(a=>a.effect.getTiming().duration===180 && a.effect.target.textContent.includes('added.ts'))")
  await click('#list-text')
  check(await read("document.getAnimations().includes(window.__toolEntrance)"), 'text update cut short or restarted the new tool entrance')
  await settle()
  for (let index=0;index<4;index++) await click('#list-text')
  check(await read("!document.getAnimations().some(a=>a.effect.getTiming().duration===180 && a.effect.getKeyframes().some(frame=>'transform' in frame))"), 'text tokens replayed structural entry')
  await arm("a.effect.getTiming().duration===180 && node.closest('.turn-hooks-summary')")
  await click('#list-hook')
  await wait("document.querySelector('.turn-hook-phase')")
  if (await read("!document.querySelector('.turn-hooks-summary').open")) await click('.turn-hooks-summary>summary')
  const hookArrival = await captured()
  if (await read("!document.querySelector('.turn-hook-phase').open")) await click('.turn-hook-phase>summary')
  await wait("document.querySelector('.turn-hook-phase').open")
  check(hookArrival.every(animation=>animation.duration===180), 'new hook rows did not enter for 180ms')
  await settle()
  check(await read("!document.getAnimations().some(a=>a.effect.getTiming().duration===180 && a.effect.target.closest('.turn-hooks-summary'))"), 'hook disclosure entrance had not settled before lifecycle response')
  await read('window.listFixture.hookResponse()')
  await wait('window.listFixture.hookResponses===1')
  check(await read("!document.getAnimations().some(a=>a.effect.getTiming().duration===180 && a.effect.target.closest('.turn-hooks-summary'))"), 'hook lifecycle response replayed row')
  await arm("a.effect.getTiming().duration===180 && node.matches('.turn-tail')")
  await click('#list-complete')
  await wait("document.querySelector('.turn-footer')")
  const footerArrival = await captured()
  check(footerArrival.length===1 && footerArrival[0].duration===180, 'completed live metrics did not enter once for 180ms')
  await settle()
  // Cache/loading boundaries retire live eligibility, even if the turn data grows.
  await attachLive()
  await read('window.listFixture.setCache(true)')
  await wait("document.querySelector('.session-loading') || document.querySelector('textarea')")
  await read('window.listFixture.appendTool()')
  await wait("document.querySelectorAll('.tool-card').length===3")
  check(await read("!document.getAnimations().some(a=>a.effect.getTiming().duration===180 && (a.effect.target.matches('.tool-card')||a.effect.target.querySelector('.tool-card')))"), 'cached restore fabricated live arrival')
  await attachLive(); await settle()
  await read('window.listFixture.setLoading(true)')
  await wait('window.listFixture.loading')
  await read('window.listFixture.appendTool(); window.listFixture.setLoading(false)')
  await wait('!window.listFixture.loading')
  await expandTools(3)
  check(await read("!document.querySelector('.stream-arrival')"), 'loading baseline fabricated live entry')
  await read('window.listFixture.switchScope()')
  await wait("document.querySelectorAll('.tool-card').length===4")
  check(await read("!document.querySelector('.stream-arrival')"), 'session identity switch fabricated live entry')
  await arm("a.effect.getTiming().duration===180 && (node.matches('.tool-card')||node.querySelector('.tool-card'))")
  await read('window.listFixture.appendTool()')
  check((await captured()).length===1, 'session identity baseline suppressed the next genuine arrival')
  await settle()
  contents.debugger.attach('1.3')
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await wait("matchMedia('(prefers-reduced-motion: reduce)').matches")
    await click('#list-analytics'); await wait("document.querySelector('.usage-state')")
    await arm("node.classList.contains('motion-stagger')")
    await click('#list-resolve')
    const reduced = await captured()
    check(reduced.length===1 && reduced[0].duration===120 && reduced[0].delay===0 && opacityOnly(reduced), `reduced whole-list fade invalid: ${JSON.stringify(reduced)}`)
    await settle(); await click('#list-chat')
    await click('#list-append')
    await wait("document.querySelectorAll('#list-sidebar .sb-sess-row').length===4")
    check(await read("!document.getAnimations().some(a=>a.effect.target.closest('#list-sidebar') && a.effect.target.hasAttribute('data-motion-key'))"), 'reduced FLIP animated')
    await click('.sb-view-tabs [role=tab]:nth-of-type(2)')
    await wait("document.querySelector('.sb-view-tabs [role=tab]:nth-of-type(2)').getAttribute('aria-selected')==='true'")
    check(await read("!document.getAnimations().some(a=>a.effect.target.closest('.sb-view-tabs') && a.effect.getKeyframes().some(frame=>'transform' in frame))"), 'reduced tab strip animated')
    await attachLive()
    await arm("a.effect.getTiming().duration===120 && (node.matches('.tool-card')||node.querySelector('.tool-card'))")
    await click('#list-tool')
    const reducedArrival = await captured()
    check(opacityOnly(reducedArrival), 'reduced stream block retained transform')
    await settle()
    await read('window.listFixture.longOutput()')
    await wait("document.querySelectorAll('.tool-card').length===4")
    await expandTools(4)
    await settle()
    const reducedLongTool = `[aria-controls=${JSON.stringify(await read("[...document.querySelectorAll('.tool-card .tool-row')].at(-1).getAttribute('aria-controls')"))}]`
    await arm("node.classList.contains('motion-disclosure') && !!node.querySelector('.tool-detail-region')")
    await click(reducedLongTool)
    const reducedLongEnter = await captured()
    check(await read("document.querySelector('.tool-detail-region').closest('.motion-disclosure').dataset.long==='true'"), 'Reduced long-output fixture did not render long content')
    check(reducedLongEnter.every(a=>a.duration===120) && opacityOnly(reducedLongEnter), `reduced long output did not enter in 120ms: ${JSON.stringify(reducedLongEnter)}`)
    await settle()
    await arm("node.classList.contains('motion-disclosure') && !!node.querySelector('.tool-detail-region')")
    await click(reducedLongTool)
    const reducedLongExit = await captured()
    check(reducedLongExit.every(a=>a.duration===120) && opacityOnly(reducedLongExit), `reduced long output did not exit in 120ms: ${JSON.stringify(reducedLongExit)}`)
  } finally {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})
    contents.debugger.detach()
    await read('window.__listObserver?.disconnect()')
  }
  return { appendedToolOnly180: true, hookRows180AndLifecycleDoesNotReplay: true, tokensDoNotReplay: true, liveMetrics180: true, cacheNoEntry: true, loadingAndSessionIdentityNoEntry: true, reducedOpacityOnly: true, reducedLongEnterAndExit120: true }
}
