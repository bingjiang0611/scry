// Native structure campaign; serialized with its caller into the isolated Electron fixture.
export async function exerciseListStructure({ read, check, wait, click, settle, arm, captured, screenshot, contents }) {
  const reports = []
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
    await click('#list-analytics')
    await wait("document.querySelector('.usage-state')")
    await arm("a.animationName==='row-in' && node.closest('.usage-breakdown')")
    await click('#list-resolve')
    const stagger = await captured()
    check(stagger.length === 12, `${theme}: expected all 12 real analytics rows, got ${stagger.length}`)
    check(stagger.every(row => row.duration === 220), `${theme}: row duration not 220ms`)
    check(stagger.slice(0, 10).every((row, index) => Math.abs(row.delay - index * 16) < 1e-6), `${theme}: first ten stagger delays ${JSON.stringify(stagger.map(row=>row.delay))}`)
    check(stagger[10].delay === 0 && stagger[11].delay === 0, `${theme}: row 11/12 must have no stagger delay`)
    await wait("!document.querySelector('.usage-breakdown .motion-stagger')")
    await click('#list-refresh')
    await wait('window.listFixture.refreshes > 0')
    check(await read("!document.getAnimations().some(a=>a.animationName==='row-in' && a.effect.target.closest('.usage-breakdown'))"), `${theme}: refresh replayed rows`)
    await screenshot(`${theme}-analytics`)
    for (const modal of ['skills', 'mcp', 'llm']) {
      await click(`#list-${modal}`)
      await wait("document.querySelector('.modal-overlay .motion-stagger')")
      await settle()
      await screenshot(`${theme}-${modal}`)
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' }); contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
      await wait("!document.querySelector('.modal-overlay')")
    }
    await click('#list-meta')
    await wait("document.querySelectorAll('.mp-row').length===12")
    await settle(); await screenshot(`${theme}-meta`)
    await click('#list-chat')
    await wait("document.querySelector('.chat-scroll') || document.querySelector('textarea')")
    await arm("node.hasAttribute('data-motion-key') && node.closest('#list-sidebar')")
    await click('#list-append')
    const flip = await captured()
    check(flip.some(animation => animation.duration === 300 && animation.frames.some(frame => 'transform' in frame)), `${theme}: existing sessions did not move for 300ms`)
    check(flip.some(animation => animation.duration === 220 && animation.frames[0].opacity === '0'), `${theme}: newly added session did not enter for 220ms`)
    await settle()
    await click('#list-sidebar .sb-proj-head')
    await wait("document.querySelector('#list-sidebar .sb-proj-head').getAttribute('aria-expanded')==='false'")
    const retiring = await read("(() => {const n=document.querySelector('#list-sidebar .sb-sess-list');return {present:!!n,inert:!!n?.closest('[inert]'),hidden:!!n?.closest('[aria-hidden=true]')}})()")
    check(retiring.present && retiring.inert && retiring.hidden, `${theme}: closing group was not retained inert/hidden: ${JSON.stringify(retiring)}`)
    await wait("!document.querySelector('#list-sidebar .sb-sess-list')")
    await click('#list-sidebar .sb-proj-head')
    await wait("document.querySelector('#list-sidebar .sb-sess-list')")
    await settle(); await screenshot(`${theme}-sidebar`)
    reports.push({ theme, analyticsRows: stagger.length, firstTenDelays: stagger.slice(0,10).map(row=>row.delay), remainingDelay: stagger[10].delay,
      flipDurations: flip.map(animation=>animation.duration), collapseRetiredAfterExit: true })
  }
  // Exercise the actual >40 policy without shrinking fixture data or DOM.
  await click('#list-large')
  await wait("document.querySelectorAll('#list-sidebar .sb-sess-row').length===45")
  check(await read("!document.getAnimations().some(a=>a.effect.target.closest('#list-sidebar') && a.effect.target.hasAttribute('data-motion-key'))"), 'oversized list animated')
  await click('#list-small')
  await wait("document.querySelectorAll('#list-sidebar .sb-sess-row').length===3")
  check(await read("!document.getAnimations().some(a=>a.effect.target.closest('#list-sidebar') && a.effect.target.hasAttribute('data-motion-key'))"), 'resuming budget fabricated arrivals')
  await read('window.listFixture.pinCount(2)')
  await wait("document.querySelectorAll('#list-sidebar .sb-pinned [data-motion-key]').length===2")
  await settle()
  await arm("node.closest('.sb-pinned') && ['scry-list-arrival','scry-list-reorder'].includes(a.id)")
  await read('window.listFixture.pinCount(3)')
  const pinnedMotion = await captured()
  check(pinnedMotion.some(animation=>animation.duration===220) && pinnedMotion.filter(animation=>animation.duration===300).length===2, 'pinned list omitted arrival or survivor FLIP')
  await click('#list-small')
  await settle()
  // Count the real layout getters and tab-root observations across unrelated renders.
  await read(`(() => {
    window.__tabReads = 0
    window.__tabObservations = 0
    window.__tabNodes = [...document.querySelectorAll('.sb-view-tabs [role=tab], .surface-tab')]
    for (const node of window.__tabNodes) for (const key of ['offsetLeft', 'offsetWidth']) {
      const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key).get
      Object.defineProperty(node, key, { configurable: true, get() { window.__tabReads++; return getter.call(this) } })
    }
    window.__originalTabObserver = window.ResizeObserver
    window.ResizeObserver = class extends window.__originalTabObserver {
      observe(node, options) {
        if (node.matches('.sb-view-tabs, .surface-tabs')) window.__tabObservations++
        super.observe(node, options)
      }
    }
  })()`)
  try {
    for (const busy of [true, false]) {
      await read(`window.listFixture.setBusy(${busy}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    }
    check(await read('window.__tabReads===0 && window.__tabObservations===0'), 'unrelated renders reread tab geometry or rebuilt observers')
  } finally {
    await read(`window.ResizeObserver=window.__originalTabObserver; for(const node of window.__tabNodes) { delete node.offsetLeft; delete node.offsetWidth }`)
  }
  // Selection color changes in the same commit as aria-selected, not a color tween.
  const switchTab = async (root, selector) => {
    selector = `[id=${JSON.stringify(await read(`document.querySelector(${JSON.stringify(selector)}).id`))}]`
    const colors = await read(`(() => {const root=document.querySelector(${JSON.stringify(root)}); return {active:getComputedStyle(root.querySelector('[role=tab][aria-selected=true]')).color,target:getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color}})()`)
    await arm(`a.effect.getTiming().duration===220 && !!node.closest(${JSON.stringify(root)}) && a.effect.getKeyframes().some(frame=>'transform' in frame)`)
    await click(selector)
    await wait(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-selected')==='true'`)
    const animations = await captured()
    check(animations.length === 1 && animations[0].duration === 220, `${root}: indicator was not one 220ms animation: ${JSON.stringify(animations)}`)
    check(await read(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).color===${JSON.stringify(colors.active)}`), `${root}: selected text color was delayed`)
    check(await read(`!document.querySelector(${JSON.stringify(selector)}).getAnimations().some(a=>a.effect.getKeyframes().some(frame=>'color' in frame))`), `${root}: text color interpolated`)
    await settle()
  }
  await switchTab('.sb-view-tabs', '.sb-view-tabs [role=tab]:nth-of-type(2)')
  await switchTab('.sb-view-tabs', '.sb-view-tabs [role=tab]:nth-of-type(1)')
  await switchTab('.surface-tabs', '.surface-tabs [role=tab]:not([aria-selected=true])')
  await click('#list-surface')
  await wait("document.querySelectorAll('.surface-tabs [role=tab]').length===3")
  check(await read("!document.getAnimations().some(a=>a.effect.target.closest('.surface-tabs') && a.effect.getKeyframes().some(frame=>'transform' in frame))"), 'adding surface animated indicator')
  await click('.surface-tab.active .surface-tab-close')
  await wait("document.querySelectorAll('.surface-tabs [role=tab]').length===2")
  check(await read("!document.getAnimations().some(a=>a.effect.target.closest('.surface-tabs') && a.effect.getKeyframes().some(frame=>'transform' in frame))"), 'removing surface animated indicator')
  const beforeResize = await read("document.querySelector('.surface-tabs').getBoundingClientRect().width")
  await read("document.querySelector('#list-surfaces').style.width='390px';document.querySelector('#list-surfaces').style.minWidth='390px'")
  await wait(`document.querySelector('.surface-tabs').getBoundingClientRect().width!==${beforeResize}`)
  check(await read("!document.getAnimations().some(a=>a.effect.target.closest('.surface-tabs') && a.effect.getKeyframes().some(frame=>'transform' in frame))"), 'resize animated indicator')
  await click('#list-queue'); await wait("document.querySelectorAll('.queue-item').length===1")
  await click('#list-queue'); await wait("document.querySelectorAll('.queue-item').length===2")
  await settle()
  await arm("node.closest('.queue-list') && a.effect.getTiming().duration===300")
  await click('.queue-remove')
  check((await captured()).every(animation=>animation.duration===300), 'queue survivors did not close the gap')
  await wait("document.querySelectorAll('.queue-item').length===1")
  await click('#list-task'); await wait("document.querySelectorAll('.background-work-task').length===1")
  await click('#list-task'); await wait("document.querySelectorAll('.background-work-task').length===2")
  await settle()
  await arm("node.closest('.background-work-panel') && a.effect.getTiming().duration===300")
  await read('window.listFixture.removeFirstTask()')
  check((await captured()).every(animation=>animation.duration===300), 'background task survivors did not close the gap')
  await wait("document.querySelectorAll('.background-work-task').length===1")
  return { themes: reports, oversized45RetainedWithoutFlip: true, pinnedArrival220AndSurvivors300: true, unrelatedRendersNoTabReadsOrObserverRebuild: true, selection220AndImmediateColor: true, dynamicTabsAndResizeJump: true, queueAndTaskSurvivors300: true }
}
