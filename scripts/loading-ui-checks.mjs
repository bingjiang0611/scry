// Full production App plus native remote picker; controlled read promises only.
export async function exerciseLoading(contents, win, pointerSource, screenshotPrefix = '') {
  const read = expression => contents.executeJavaScript(expression)
  const check = (ok, message) => { if (!ok) throw new Error(`Loading: ${message}`) }
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() >= deadline) throw new Error(`Loading condition timed out: ${expression}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const click = async (selector, text = '') => {
    const point = await read(`(${pointerSource})(${JSON.stringify(selector)}, { text: ${JSON.stringify(text)}, timeoutMs: 5000, scroll: true, captureReceipt: true })`)
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await wait('window.__nativeUiPointerReceipt?.trusted && window.__nativeUiPointerReceipt.targetMatched')
  }
  const settle = () => read(`Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`)
  const screenshot = async name => {
    if (screenshotPrefix) require('node:fs').writeFileSync(`${screenshotPrefix}-${name}.png`, (await contents.capturePage()).toPNG())
  }
  await wait("window.loadingFixture && document.querySelectorAll('button.sb-sess').length===2")
  const select = id => click('button.sb-sess', id)
  const ready = id => wait(`document.querySelector('.chat-transcript').getAttribute('aria-busy')==='false' && document.querySelector('.chat-transcript').textContent.includes(${JSON.stringify('Authoritative '+id)})`)
  // Seed both real App composer scopes, so an empty draft cannot explain disabled send.
  for (const id of ['cache-a', 'cache-b', 'cache-a']) {
    await select(id); await ready(id); await settle()
    if (await read("!document.querySelector('.runtime-composer textarea').value")) {
      await click('.runtime-composer textarea')
      await wait("document.activeElement===document.querySelector('.runtime-composer textarea')")
      await contents.insertText(`draft ${id}`)
      await wait("document.querySelector('.runtime-composer textarea').value.length>0")
    }
  }
  const arm = async () => read(`(() => {
    window.__loadingObserver?.disconnect(); cancelAnimationFrame(window.__loadingFrame)
    const old = document.querySelector('.transcript-turn')
    const initialY = old?.getBoundingClientRect().top
    const state = window.__loadingState = { since:performance.now(), first:null, seen:false, busy:false, draft:false, badControls:false, retained:true, fade:null, hidden:false, shifted:false, replacement:false, reducedStatic:true, reducedVisible:true }
    const scan = () => {
      const record = window.loadingFixture.records.filter(r=>r.kind==='session' && r.start>=state.since).at(-1)
      const transcript = document.querySelector('.chat-transcript')
      const busy = transcript?.getAttribute('aria-busy')==='true'
      const indicator = document.querySelector('.chat-session-evidence-gap[data-status=loading]')
      if(record && indicator) {
        state.seen=true; state.first ??= performance.now()-record.start
        state.role=indicator.getAttribute('role'); state.text=indicator.textContent
        const bar=indicator.querySelector('.loading-status-bar')
        state.barHeight=bar.getBoundingClientRect().height
        if(matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const style=getComputedStyle(bar,'::after')
          state.reducedStatic &&= style.animationName==='none' && style.transform==='none'
          if(performance.now()-record.start>290 && busy) state.reducedVisible &&= getComputedStyle(indicator).opacity==='1' && bar.getBoundingClientRect().width>0 && !!indicator.textContent.trim()
        }
      }
      if(record && busy) {
        state.busy=true
        state.draft ||= document.querySelector('.runtime-composer textarea').value.length>0
        state.badControls ||= !document.querySelector('button.send').disabled || [...document.querySelectorAll('.turn-branch-btn')].some(n=>!n.disabled && !n.closest('[inert]'))
        const previous=transcript.querySelector('[data-loading-previous=true]')
        state.retained &&= !!previous?.inert && previous.getAttribute('aria-hidden')==='true' && previous.contains(old)
        state.shifted ||= Math.abs(old.getBoundingClientRect().top-initialY)>1
        const fade=previous?.getAnimations().find(a=>a.id==='scry-loading-previous')
        if(fade) state.fade={duration:fade.effect.getTiming().duration,frames:fade.effect.getKeyframes(),live:fade.effect.target===previous}
        if(record && performance.now()-record.start>290) state.hidden ||= getComputedStyle(previous).opacity==='0'
      }
      state.replacement ||= document.getAnimations().some(a=>a.id==='scry-structure' && a.effect.getTiming().duration===180 && a.effect.getKeyframes().every(frame=>!('transform' in frame)))
    }
    window.__loadingObserver=new MutationObserver(mutations => {
      // Inspect inserted subtrees even if React removed them again before this callback.
      // A current-DOM-only scan cannot prove that a short request never mounted a loader.
      const request=window.loadingFixture.records.find(r=>r.kind==='session' && r.start>=state.since)
      if(request && mutations.some(m=>[...m.addedNodes].some(n=>n instanceof Element &&
        (n.matches('.chat-session-evidence-gap[data-status=loading]') || n.querySelector('.chat-session-evidence-gap[data-status=loading]'))))) state.seen=true
      scan()
    })
    window.__loadingObserver.observe(document.body,{subtree:true,childList:true,attributes:true})
    const frame=()=>{scan(); window.__loadingFrame=requestAnimationFrame(frame)}
    window.__loadingFrame=requestAnimationFrame(frame)
  })()`)
  const report = async () => {
    await read('window.__loadingObserver.disconnect(); cancelAnimationFrame(window.__loadingFrame)')
    return read('window.__loadingState')
  }
  const measured = async (id, delay, fail = false) => {
    await settle()
    await read(`window.loadingFixture.invalidateCache(); window.loadingFixture.configure(${delay},${fail})`)
    await arm(); await select(id)
    if (delay === 400 && screenshotPrefix) {
      await wait("(() => {const status=document.querySelector('.chat-session-evidence-gap[data-status=loading]'); return status && Number(getComputedStyle(status).opacity)>0.9})()")
      const reducedMode = await read("matchMedia('(prefers-reduced-motion: reduce)').matches")
      await screenshot(fail ? 'failure-loading' : reducedMode ? 'reduced-loading' : 'slow-loading')
    }
    if (fail) await wait("document.querySelector('.chat-session-evidence-gap[data-status=error]')?.textContent.includes('fixture source unavailable')")
    else await ready(id)
    const result = await report()
    check(result.busy && result.draft && !result.badControls, `send/fork authority was delayed: ${JSON.stringify(result)}`)
    check(result.retained && !result.shifted, `previous live DOM was removed or shifted: ${JSON.stringify(result)}`)
    check(!await read("!!document.querySelector('.chat-session-evidence-gap[data-status=loading]')"), 'loading bar survived completion/error')
    return result
  }
  const fast = await measured('cache-b', 60)
  check(!fast.seen && !fast.fade && fast.replacement, `60ms flashed a loader, faded old DOM or lost 180ms replacement: ${JSON.stringify(fast)}`)
  const slow = await measured('cache-a', 400)
  check(slow.first>=110 && slow.first<=190 && slow.role==='status' && slow.text.includes('正在加载会话历史') && slow.barHeight===2, `400ms loading onset/semantics invalid: ${JSON.stringify(slow)}`)
  check(slow.fade?.duration===120 && slow.fade.live && slow.hidden && slow.fade.frames.every(frame=>!('transform' in frame)), `old transcript did not fade on live DOM for 120ms: ${JSON.stringify(slow)}`)
  const failed = await measured('cache-b', 400, true)
  check(failed.seen, 'long failed read never showed honest loading')
  await screenshot('failure')
  contents.debugger.attach('1.3')
  let reduced
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await wait("matchMedia('(prefers-reduced-motion: reduce)').matches")
    // Restore real content first; then measure a slow switch from a populated timeline.
    await read('window.loadingFixture.configure(60)'); await select('cache-b'); await ready('cache-b')
    reduced = await measured('cache-a', 400)
    check(reduced.seen && reduced.reducedStatic && reduced.reducedVisible && reduced.hidden, `reduced progress blinked, moved or lost its text: ${JSON.stringify(reduced)}`)
    await screenshot('reduced-ready')
  } finally {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}); contents.debugger.detach()
  }
  // Other read surfaces use the same primitive; controls/evidence stay synchronous.
  const surfaces = []
  for (const [title, kind] of [['Skills','skills'],['MCP','mcp']]) {
    await read('window.loadingFixture.configure(400)')
    await click(`.sb-navitem[title=${JSON.stringify(title)}]`)
    await wait(`document.querySelector('.capabilities-modal--${kind}')`)
    check(!await read("!!document.querySelector('.capabilities-modal .capabilities-empty')"), `${kind} showed empty evidence while loading`)
    await wait("document.querySelector('.capabilities-modal .loading-status')")
    check(await read("document.querySelector('.capabilities-body').getAttribute('aria-busy')==='true'"), `${kind} delayed aria-busy`)
    await wait("!document.querySelector('.capabilities-modal .loading-status') && document.querySelector('.capabilities-empty')")
    surfaces.push(kind)
    await click('.capabilities-close'); await wait("!document.querySelector('.modal-overlay')")
  }
  await read('window.loadingFixture.configure(400)')
  await click('.sb-navitem:not([title])')
  await wait("document.querySelector('.usage-page .loading-status')")
  await wait("!document.querySelector('.usage-page .loading-status')")
  surfaces.push('analytics')
  await read("window.loadingFixture.configure(400); window.loadingFixture.remote('projects')")
  await wait("document.querySelector('#loading-projects .loading-status')")
  check(!await read("document.querySelector('#loading-projects').textContent.includes('这台主机还没有项目')"), 'remote pending catalog became empty')
  await wait("document.querySelector('#loading-projects .location-project-list')")
  await screenshot('remote-projects')
  await read('window.loadingFixture.closeRemote()')
  await read("window.loadingFixture.configure(400); window.loadingFixture.remote('directory')")
  await wait("document.querySelector('.remote-directory-modal .loading-status')")
  check(await read("document.querySelector('.remote-directory-body').getAttribute('aria-busy')==='true' && document.querySelector('.remote-directory-actions .is-primary').disabled"), 'directory browsing delayed its authority guard')
  await wait("document.querySelector('[data-remote-directory=\"/remote/child\"]')")
  await click('[data-remote-directory="/remote/child"]')
  await wait("document.querySelector('.remote-directory-modal .loading-status')")
  await wait("document.querySelector('.remote-directory-path input').value==='/remote/child' && !document.querySelector('.remote-directory-modal .loading-status')")
  await screenshot('remote-directory')
  await read('window.loadingFixture.closeRemote()')
  surfaces.push('remote-projects','remote-directory-navigation')
  const inventoryFailures = []
  for (const legacy of [true, false]) for (const kind of ['skills', 'mcp']) {
    const label = `${legacy ? 'legacy' : 'capabilities'}-${kind}`
    const missing = kind === 'skills' ? '未取得 Skill 清单' : '未取得 MCP 配置'
    const empty = legacy ? kind === 'skills' ? '未发现项目 Skill' : '未发现 MCP 配置' : kind === 'skills' ? '当前来源没有 Skill' : '当前来源没有 MCP'
    const modal = '.modal-overlay [role="dialog"]'
    const body = `${modal} .inventory-modal__body, ${modal} .capabilities-body`
    const status = `${modal} .inventory-empty[role="status"], ${modal} .capabilities-empty[role="status"]`
    const invalidEvidence = `(() => { const el = document.querySelector(${JSON.stringify(modal)}); return /(^|[^0-9])0([^0-9]|$)/.test(el.textContent) || !!el.querySelector('.inventory-empty, .capabilities-empty') })()`
    const before = await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).length`)
    await read(`window.loadingFixture.configure(400, true); window.loadingFixture.inventory(${JSON.stringify(kind)}, ${legacy})`)
    await wait(`document.querySelector(${JSON.stringify(modal)})`)
    await settle()
    check(!await read(invalidEvidence), `${label} showed failed or empty evidence before a read started`)
    check(await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).length===${before}`), `${label} started reading before the existing request trigger`)
    await read('window.loadingFixture.startInventory()')
    await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='true'`)
    check(!await read(invalidEvidence), `${label} showed failed or empty evidence during a read`)
    await wait(`document.querySelector(${JSON.stringify(modal + ' .loading-status')})`)
    await wait(`document.querySelector(${JSON.stringify(status)})?.textContent.includes(${JSON.stringify(missing)})`)
    check(await read(`(() => { const el=document.querySelector(${JSON.stringify(modal)}); return !el.querySelector('.loading-status') && !/(^|[^0-9])0([^0-9]|$)/.test(el.textContent) && document.querySelector(${JSON.stringify(body)}).getAttribute('aria-busy')==='false' })()`), `${label} retained a loading bar, busy flag or false zero after rejection`)
    check(await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).slice(${before}).length===1 && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).at(-1).failed===true`), `${label} did not reject exactly one real read`)
    await screenshot(`${label}-failed`)
    await read('window.loadingFixture.configure(400, false)')
    await click(legacy ? `${modal} .modal-refresh` : kind === 'skills' ? `${status} .capabilities-refresh` : `${modal} .capabilities-head .capabilities-refresh`)
    await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='true'`)
    check(!await read(`document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(missing)})`), `${label} kept the failure message during retry`)
    await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='false' && document.querySelector(${JSON.stringify(status)}) && !document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(missing)})`)
    check(await read(`document.querySelector(${JSON.stringify(status)}).textContent.includes(${JSON.stringify(empty)}) && !document.querySelector(${JSON.stringify(modal + ' .loading-status')}) && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).slice(${before}).length===2 && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).at(-1).failed===false`), `${label} did not show a successful empty result after native refresh`)
    inventoryFailures.push(label)
    await read('window.loadingFixture.closeInventory()')
    await wait("!document.querySelector('.modal-overlay')")
  }
  const counts = await read("JSON.parse(document.querySelector('#cache-state').textContent)")
  check(counts.starts===0 && counts.forks===0, 'fixture launched a Provider or fork')
  return { fast60NoLoading: true, slow400FirstMs: slow.first, oldLiveDomFade120: true, authorityImmediate: true,
    failureNoResidual: true, reducedStaticProgress: true, otherSurfaces: surfaces, inventoryFailures, noProviderOrFork: true }
}
