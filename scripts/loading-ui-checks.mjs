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
    if (!screenshotPrefix) return
    contents.invalidate()
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    require('node:fs').writeFileSync(`${screenshotPrefix}-${name}.png`, (await contents.capturePage()).toPNG())
  }
  await wait("window.loadingFixture && document.querySelectorAll('button.sb-sess').length===2")
  const select = id => click('button.sb-sess', id)
  const ready = id => wait(`document.querySelector('.chat-transcript[aria-busy="false"][data-history-source="authoritative"]') && document.querySelector('.chat-transcript').textContent.includes(${JSON.stringify('Authoritative '+id)})`)
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
  const arm = async target => read(`(() => {
    window.__loadingObserver?.disconnect(); cancelAnimationFrame(window.__loadingFrame)
    window.__loadingReadObservation?.abort()
    const state = window.__loadingState = { since:performance.now(), seen:false, pending:false, badControls:false, identityStable:true, preview:true, authority:false, visible:true, shifted:false, replacement:false, draft:null, top:null, reserved:null }
    // The timeline's own session-history status. ChatView renders it as standard flow content
    // above .chat-transcript-content while sessionLoading || sessionCacheVisible, so it moves the
    // turn down by exactly its own height while the read is pending.
    const loaderOf = transcript => transcript?.querySelector('.loading-status[data-status="loading"], .skeleton-rows') ?? null
    const scan = () => {
      const record = window.loadingFixture.records.filter(r=>r.kind==='session' && r.start>=state.since).at(-1)
      const transcript = document.querySelector('.chat-transcript')
      const loader = loaderOf(transcript)
      if(record && !record.end) {
        // Approved catalog-preview contract (57251373): the target owns the page from the first
        // frame and the standard delayed status is intentionally shown during a slow read, so the
        // guards are "target selected, its own preview visible, no old authority" plus a shift
        // budget of exactly that status' flow height.
        if (loader) state.seen = true
        state.pending = true
        state.identityStable &&= document.querySelector('.sb-sess[aria-current=true]')?.textContent.includes(${JSON.stringify(target)})
        const turn = transcript?.querySelector('.transcript-turn')
        state.preview &&= transcript?.getAttribute('data-history-source') === 'preview' && turn?.getAttribute('data-run-id') === ${JSON.stringify(`session-preview:${target}`)}
        state.authority ||= (transcript?.textContent ?? '').includes('Authoritative')
        state.draft ??= document.querySelector('.runtime-composer textarea')?.value ?? ''
        state.badControls ||= !document.querySelector('button.send')?.disabled || [...document.querySelectorAll('.turn-branch-btn')].some(n=>!n.disabled)
        const shown = [turn, turn?.parentElement, transcript].every(element => {
          if(!element || !element.isConnected || element.getBoundingClientRect().height<=0) return false
          const style=getComputedStyle(element)
          return Number(style.opacity)>0 && style.display!=='none' && style.visibility==='visible'
        })
        if(!shown) state.visible=false
        else {
          const top = turn.getBoundingClientRect().top + transcript.scrollTop
          const reserved = loader ? loader.getBoundingClientRect().height : 0
          state.top ??= top
          state.reserved ??= reserved
          const drift = (top - state.top) - (reserved - state.reserved)
          if (Math.abs(drift)>1 && !state.shifted) state.firstShift = {
            from:state.top, to:top, reservedFrom:state.reserved, reservedTo:reserved, drift,
            runId:turn.dataset.runId, source:transcript.dataset.historySource, scrollTop:transcript.scrollTop,
            ancestors:[turn,turn.parentElement,transcript,transcript.parentElement].map(node=>({className:node.className,transform:getComputedStyle(node).transform,top:node.getBoundingClientRect().top}))
          }
          state.shifted ||= Math.abs(drift)>1
        }
      }
      state.replacement ||= document.getAnimations().some(a=>a.id==='scry-structure' && a.effect.getTiming().duration===400 && a.effect.getKeyframes().every(frame=>!('transform' in frame)))
    }
    window.__loadingReadObservation = new AbortController()
    window.addEventListener('loading-fixture-session-read', scan, { signal: window.__loadingReadObservation.signal })
    window.__loadingObserver=new MutationObserver(mutations => {
      // Include transient insertions: polling the current DOM cannot disprove a flash.
      const request=window.loadingFixture.records.find(r=>r.kind==='session' && r.start>=state.since)
      const loader = node => node.matches('.loading-status[data-status="loading"], .skeleton-rows') || node.querySelector('.loading-status[data-status="loading"], .skeleton-rows') != null
      // Scope by the mutation target, not by the added node's current ancestors: React can remove
      // the loader before this callback, which would detach the node and lose the short-lived case.
      if(request && mutations.some(m=>m.target instanceof Element && m.target.closest('.chat-transcript') != null && [...m.addedNodes].some(n=>n instanceof Element && loader(n)))) state.seen=true
      scan()
    })
    window.__loadingObserver.observe(document.querySelector('.chat-body'),{subtree:true,childList:true,attributes:true})
    const frame=()=>{scan(); window.__loadingFrame=requestAnimationFrame(frame)}
    window.__loadingFrame=requestAnimationFrame(frame)
  })()`)
  const report = async () => {
    await read('window.__loadingObserver.disconnect(); cancelAnimationFrame(window.__loadingFrame); window.__loadingReadObservation.abort()')
    return read('window.__loadingState')
  }
  const measured = async (id, delay, fail = false) => {
    await settle()
    await read(`window.loadingFixture.invalidateCache(); window.loadingFixture.configure(${delay},${fail})`)
    await arm(id); await select(id)
    if (delay === 1000) await select(id)
    if (delay === 1000 && screenshotPrefix) {
      await wait("window.__loadingState.pending && performance.now()-window.__loadingState.since>800")
      const reducedMode = await read("matchMedia('(prefers-reduced-motion: reduce)').matches")
      await screenshot(fail ? 'failure-loading' : reducedMode ? 'reduced-loading' : 'slow-loading')
    }
    if (fail) await wait("document.querySelector('.chat-state-slot > .empty-state[data-status=error]')?.textContent.includes('没能读取会话历史')")
    else await ready(id)
    const result = await report()
    check(result.pending && !result.badControls, `read was not observed or target controls lacked authority: ${JSON.stringify(result)}`)
    check(result.identityStable && result.visible && !result.shifted, `target preview was not presented atomically: ${JSON.stringify(result)}`)
    check(result.preview && !result.authority, `pending read did not present the target preview only: ${JSON.stringify(result)}`)
    check((result.draft ?? '').trim().length > 0, `empty draft cannot prove the send/fork lock: ${JSON.stringify(result)}`)
    check(await read(`window.loadingFixture.records.filter(r=>r.kind==='session' && r.start>=window.__loadingState.since).length===1`), 'opening an uncached session read history twice')
    check(!await read("!!document.querySelector('.chat-transcript .loading-status[data-status=loading], .chat-transcript .skeleton-rows')"), 'session-history loading status survived completion/error')
    return result
  }
  const fast = await measured('cache-b', 60)
  check(!fast.seen && fast.replacement, `60ms read flashed the session-history status or lost the 400ms replacement: ${JSON.stringify(fast)}`)
  const slow = await measured('cache-a', 1000)
  check(slow.seen, `slow session read never showed the standard loading status: ${JSON.stringify(slow)}`)
  const failed = await measured('cache-b', 1000, true)
  check(failed.seen, 'failed session read never showed the standard loading status')
  await screenshot('failure')
  const retry = '.chat-state-slot > .empty-state[data-status=error] button'
  await settle()
  const frame = await read(`(() => {
    const panel = document.querySelector('.chat-transcript').getBoundingClientRect()
    const state = document.querySelector('.chat-state-slot > .empty-state')
    const group = state.querySelector('.empty-state-content').getBoundingClientRect()
    return { position: (group.y + group.height / 2 - panel.y) / panel.height,
      centered: Math.abs(group.x + group.width / 2 - panel.x - panel.width / 2) < 2,
      duration: state.querySelector('.empty-state-content').getAnimations()[0]?.effect.getTiming().duration,
      steps: state.querySelector('.empty-state-content').getAnimations()[0]?.effect.getKeyframes() }
  })()`)
  check(frame.centered && frame.position >= 0.36 && frame.position <= 0.47 && frame.duration === 300 && frame.steps[0].transform === 'translateY(6px)', `Empty state geometry or entrance motion is incorrect: ${JSON.stringify(frame)}`)
  const { root: { nodeId: root } } = await contents.debugger.sendCommand('DOM.getDocument')
  const axNode = async selector => {
    const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root, selector })
    const { nodes } = await contents.debugger.sendCommand('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    return nodes[0]
  }
  const title = await axNode('.chat-state-slot > .empty-state .empty-state-title')
  const picture = await axNode('.chat-state-slot > .empty-state .empty-state-picture')
  check(title.role?.value === 'heading' && title.name?.value === '没能读取会话历史' && picture.ignored, 'Electron accessibility tree does not separate real title from decoration')
  await read(`window.__emptyExitObservation = new MutationObserver(() => {
    const exit = document.querySelector('.chat-state-slot > .empty-state-outgoing')
    if (!exit) return
    const content = exit.parentElement.querySelector(':scope > .chat-transcript-content')
    const runId = content?.querySelector('.transcript-turn')?.dataset.runId
    window.__emptyExit = { inert: exit.inert, hidden: exit.getAttribute('aria-hidden') === 'true',
      noPointer: getComputedStyle(exit).pointerEvents === 'none', duration: getComputedStyle(exit).animationDuration,
      runId, contentPresent: runId === 'cache-b-turn', text: content?.textContent.slice(0, 160) }
    window.__emptyExitObservation.disconnect()
  }); window.__emptyExitObservation.observe(document.querySelector('.chat-state-slot'), { childList: true });
  window.__historyRetryButton = document.querySelector(${JSON.stringify(retry)}); window.__historyRetryCount = window.loadingFixture.records.filter(r => r.kind === 'session').length; window.loadingFixture.configure(400, false)`)
  await click(retry)
  await wait(`document.querySelector(${JSON.stringify(retry)})?.getAttribute('aria-busy') === 'true'`)
  check(await read(`document.activeElement === window.__historyRetryButton && document.querySelector(${JSON.stringify(retry)}) === window.__historyRetryButton`), 'History retry replaced the focused button during its read')
  await ready('cache-b')
  check(await read(`window.loadingFixture.records.filter(r => r.kind === 'session').length === window.__historyRetryCount + 1 && !document.querySelector(${JSON.stringify(retry)})`), 'Retry did not replace the error with authoritative history after one read')
  const exit = await read('window.__emptyExit ?? null')
  check(exit?.inert && exit.hidden && exit.noPointer && exit.contentPresent && exit.duration === '0.2s', `Empty state exit violated its interaction or timing contract: ${JSON.stringify(exit)}`)
  await wait(`!document.querySelector('.chat-state-slot > .empty-state-outgoing')`)
  let reduced
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await wait("matchMedia('(prefers-reduced-motion: reduce)').matches")
    // The retry left authoritative content in B; measure a slow switch from that populated timeline.
    reduced = await measured('cache-a', 1000)
    check(reduced.seen && reduced.visible, `reduced motion hid the standard loading status or blanked the transcript: ${JSON.stringify(reduced)}`)
    await screenshot('reduced-ready')
    await measured('cache-b', 1000, true)
    const fade = await read(`(() => {
      const effect = document.querySelector('.chat-state-slot > .empty-state .empty-state-content').getAnimations()[0]?.effect
      return effect && { duration: effect.getTiming().duration, frames: effect.getKeyframes() }
    })()`)
    check(fade?.duration === 150 && fade.frames.every(frame => !('transform' in frame)) && fade.frames[0].opacity === '0', `Reduced motion kept displacement or lost the fade: ${JSON.stringify(fade)}`)
    await read('window.loadingFixture.configure(400, false)')
    await click(retry)
    await ready('cache-b')
  } finally {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'forced-colors', value: 'none' }
    ] })
  }
  // Start a blank session while a previous selection still shows an unverified preview.
  // Neither the abandoned history read nor the catalog refresh may lock the new draft.
  await read('window.loadingFixture.configure(60); window.loadingFixture.holdSession(); window.loadingFixture.holdCatalog()')
  try {
    const previousReads = await read("window.loadingFixture.records.filter(r => r.kind === 'session').length")
    await select('cache-b')
    await wait(`document.querySelector('.chat-transcript[data-history-source=preview] .loading-status[data-status=loading]') && window.loadingFixture.records.filter(r => r.kind === 'session').length > ${previousReads}`)
    await click('.sb-new')
    await wait('window.loadingFixture.catalogPending()')
    await read(`(() => {
      const composer = document.querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, 'fresh draft')
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    if (screenshotPrefix) {
      await wait("document.querySelector('button.send:enabled, .chat-transcript[data-history-source=preview] .loading-status[data-status=loading]')")
      await screenshot('new-chat-after-history-preview')
    }
    await wait("window.loadingFixture.catalogPending() && document.querySelector('button.send:enabled') && document.querySelector('textarea')?.value === 'fresh draft'")
    await read('window.loadingFixture.releaseSession()')
    await wait("window.loadingFixture.records.filter(r => r.kind === 'session').at(-1)?.end != null")
    await settle()
    check(await read(`(() => {
      const chat = document.querySelector('.chat-transcript')
      return chat?.getAttribute('data-history-source') === 'authoritative' &&
        !chat.querySelector('.loading-status[data-status=loading], [data-run-id]') &&
        !document.querySelector('button.send').disabled
    })()`), 'abandoned history preview returned or locked the new draft')
  } finally {
    await read('window.loadingFixture.releaseSession(); window.loadingFixture.releaseCatalog()')
  }
  // Other read surfaces use the same primitive; controls/evidence stay synchronous.
  const surfaces = []
  for (const [title, kind] of [['Skills','skills'],['MCP','mcp']]) {
    await read('window.loadingFixture.configure(400)')
    await click(`.sb-navitem[title=${JSON.stringify(title)}]`)
    await wait(`document.querySelector('.capabilities-modal--${kind}')`)
    check(!await read("!!document.querySelector('.capabilities-body .empty-state')"), `${kind} showed empty evidence while loading`)
    await wait("document.querySelector('.capabilities-modal .skeleton-rows')")
    check(await read("document.querySelector('.capabilities-body').getAttribute('aria-busy')==='true'"), `${kind} delayed aria-busy`)
    await wait("!document.querySelector('.capabilities-modal .skeleton-rows') && document.querySelector('.capabilities-body .empty-state')")
    surfaces.push(kind)
    await click('.capabilities-close'); await wait("!document.querySelector('.modal-overlay')")
  }
  await read('window.loadingFixture.configure(400)')
  await click('.sb-navitem:not([title])')
  await wait("document.querySelector('.usage-page .skeleton-rows')")
  await wait("!document.querySelector('.usage-page .skeleton-rows')")
  surfaces.push('analytics')
  await read("window.loadingFixture.configure(400); window.loadingFixture.remote('projects')")
  await wait("document.querySelector('#loading-projects .loading-status')")
  check(!await read("document.querySelector('#loading-projects').textContent.includes('这台主机还没有项目')"), 'remote pending catalog became empty')
  await wait("document.querySelector('#loading-projects .location-project-list')")
  await screenshot('remote-projects')
  await read('window.loadingFixture.closeRemote()')
  await read("window.loadingFixture.configure(400); window.loadingFixture.remote('directory')")
  await wait("document.querySelector('.remote-directory-modal .skeleton-rows[role=\"status\"]')")
  check(await read("document.querySelector('.remote-directory-body').getAttribute('aria-busy')==='true' && document.querySelector('.remote-directory-actions .btn.primary').disabled"), 'directory browsing delayed its authority guard')
  await wait("document.querySelector('[data-remote-directory=\"/remote/child\"]')")
  await click('[data-remote-directory="/remote/child"]')
  await wait("document.querySelector('.remote-directory-modal .skeleton-rows[role=\"status\"]')")
  await wait("document.querySelector('.remote-directory-path input').value==='/remote/child' && !document.querySelector('.remote-directory-modal .skeleton-rows[role=\"status\"]')")
  await screenshot('remote-directory')
  await read('window.loadingFixture.closeRemote()')
  surfaces.push('remote-projects','remote-directory-navigation')
  const inventoryFailures = []
  for (const legacy of [true, false]) for (const kind of ['skills', 'mcp']) {
    const label = `${legacy ? 'legacy' : 'capabilities'}-${kind}`
    const missing = kind === 'skills' ? '没能读取 Skill 清单' : '没能读取 MCP 配置'
    const empty = legacy ? kind === 'skills' ? '未发现项目 Skill' : '未发现 MCP 配置' : kind === 'skills' ? '当前来源没有 Skill' : '当前来源没有 MCP'
    const modal = '.modal-overlay [role="dialog"]'
    const body = `${modal} .inventory-modal__body, ${modal} .capabilities-body`
    const status = `${modal} .inventory-empty[role="status"], ${modal} .capabilities-body .empty-state`
    const invalidEvidence = `(() => { const el = document.querySelector(${JSON.stringify(modal)}); return /(^|[^0-9])0([^0-9]|$)/.test(el.textContent) || !!el.querySelector('.inventory-empty, .capabilities-body .empty-state') })()`
    const before = await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).length`)
    await read(`window.loadingFixture.configure(400, true); window.loadingFixture.inventory(${JSON.stringify(kind)}, ${legacy})`)
    await wait(`document.querySelector(${JSON.stringify(modal)})`)
    await settle()
    check(!await read(invalidEvidence), `${label} showed failed or empty evidence before a read started`)
    check(await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).length===${before}`), `${label} started reading before the existing request trigger`)
    await read('window.loadingFixture.startInventory()')
    await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='true'`)
    check(!await read(invalidEvidence), `${label} showed failed or empty evidence during a read`)
    await wait(`document.querySelector(${JSON.stringify(modal + ' .skeleton-rows')})`)
    await wait(`document.querySelector(${JSON.stringify(status)})?.textContent.includes(${JSON.stringify(missing)})`)
    check(await read(`(() => { const el=document.querySelector(${JSON.stringify(modal)}); return !el.querySelector('.skeleton-rows') && !/(^|[^0-9])0([^0-9]|$)/.test(el.textContent) && document.querySelector(${JSON.stringify(body)}).getAttribute('aria-busy')==='false' })()`), `${label} retained loading rows, busy flag or false zero after rejection`)
    check(await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).slice(${before}).length===1 && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).at(-1).failed===true`), `${label} did not reject exactly one real read`)
    await screenshot(`${label}-failed`)
    await read('window.loadingFixture.configure(400, false)')
    await click(legacy ? `${modal} .modal-refresh` : kind === 'skills' ? `${modal} .capabilities-body .empty-state[role=alert] button` : `${modal} .capabilities-head .capabilities-refresh`)
    await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='true'`)
    check(!await read(`document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(missing)})`), `${label} kept the failure message during retry`)
    await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='false' && document.querySelector(${JSON.stringify(status)}) && !document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(missing)})`)
    check(await read(`document.querySelector(${JSON.stringify(status)}).textContent.includes(${JSON.stringify(empty)}) && !document.querySelector(${JSON.stringify(modal + ' .skeleton-rows')}) && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).slice(${before}).length===2 && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).at(-1).failed===false`), `${label} did not show a successful empty result after native refresh`)
    inventoryFailures.push(label)
    await read('window.loadingFixture.closeInventory()')
    await wait("!document.querySelector('.modal-overlay')")
  }
  const counts = await read("JSON.parse(document.querySelector('#cache-state').textContent)")
  check(counts.starts===0 && counts.forks===0, 'fixture launched a Provider or fork')
  return { fast60NoLoading: true, slow1000PendingStatus: true, selectionAndPreviewAtomic: true, controlsRequireAuthority: true,
    failureNoResidual: true, emptyStateGeometry: frame.position, emptyStateAX: true, nonInteractiveExit: true,
    reducedMotionPendingStatus: true, emptyStateReducedFadeOnly: true, otherSurfaces: surfaces, inventoryFailures, noProviderOrFork: true }
}
