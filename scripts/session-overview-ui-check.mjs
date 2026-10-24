export async function exerciseOverviewDensity(contents, screenshotPath) {
  const css = await contents.insertCSS(`
    body > #root > :not(#overview) { display: none !important; }
    #overview { position: fixed; inset: 0; width: 380px; }
    #overview > .overview-dossier { width: 100%; height: 100%; }
  `)
  const results = []
  const click = async (selector) => {
    const point = await contents.executeJavaScript(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Overview control obscured: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  try {
    for (const theme of ['dark', 'light']) for (const width of [380, 340, 535]) {
      await contents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.querySelector('#overview').style.width = '${width}px'`)
      const geometry = await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const header = rect('.ov-topbar'), context = rect('.ctx-gauge'), metrics = rect('.overview-metric-grid');
        const session = rect('.overview-scroll-content > .panel-section'), tabs = rect('.overview-data-tabs');
        const firstTurn = rect('.turn-call-row');
        resolve({ headerHeight: header.height, contextGap: context.top - header.bottom,
          sessionGap: session.top - metrics.bottom, tabsGap: tabs.top - session.bottom,
          firstTurnTop: firstTurn.top, overflow: document.querySelector('.ov-scroll').scrollWidth > ${width},
          columns: getComputedStyle(document.querySelector('.overview-metric-grid')).gridTemplateColumns.split(' ').length,
          metricCount: document.querySelectorAll('.overview-metric').length,
          hasInputOutput: Array.from(document.querySelectorAll('.overview-metric > span')).some(label => label.textContent === '输入 / 输出'),
          hasTitleSubtitle: document.querySelector('.overview-panel-title span') != null,
          hasTurnFootnote: document.querySelector('.turn-calls-section > .psrc') != null });
      })))`)
      if (screenshotPath && theme === 'dark' && width === 380) {
        const image = await contents.capturePage({ x: 0, y: 0, width, height: 650 })
        require('node:fs').writeFileSync(screenshotPath, image.toPNG())
      }
      if (geometry.headerHeight > 48 || geometry.contextGap > 16 || geometry.sessionGap > 16 || geometry.tabsGap > 12 || geometry.firstTurnTop > 460 || geometry.overflow || geometry.columns !== 2 || geometry.metricCount !== 3 || geometry.hasInputOutput || geometry.hasTitleSubtitle || geometry.hasTurnFootnote) {
        throw new Error('Overview density ' + theme + '/' + width + ': ' + JSON.stringify(geometry))
      }
      results.push({ theme, width, ...geometry })
    }
    contents.focus()
    if (!await contents.executeJavaScript(`document.querySelector('.overview-session-count').textContent === '0' && document.querySelector('.overview-session-id-toggle').textContent === '01a10000…0000abcd'`)) throw new Error('Session summary did not show the observed zero and shortened ID')
    await click('.overview-session-scope > button')
    if (!await contents.executeJavaScript(`document.activeElement.matches('.overview-session-scope > button') && getComputedStyle(document.querySelector('.overview-session-scope [role="tooltip"]')).visibility === 'visible'`)) throw new Error('Focused scope tooltip is unavailable')
    const tooltipPoint = await contents.executeJavaScript(`(() => { const r = document.querySelector('.overview-session-scope [role="tooltip"]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    contents.sendInputEvent({ type: 'mouseMove', ...tooltipPoint })
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (!await contents.executeJavaScript(`getComputedStyle(document.querySelector('.overview-session-scope [role="tooltip"]')).visibility === 'visible'`)) throw new Error('Scope tooltip disappeared while the pointer moved into its content')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (!await contents.executeJavaScript(`getComputedStyle(document.querySelector('.overview-session-scope [role="tooltip"]')).visibility === 'hidden'`)) throw new Error('Escape did not dismiss the scope tooltip')
    contents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    const scopeFocus = await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      idFocused: document.activeElement.matches('.overview-session-id-toggle'),
      tooltip: getComputedStyle(document.querySelector('.overview-session-scope [role="tooltip"]')).visibility,
      active: document.activeElement.outerHTML
    }))))`)
    if (!scopeFocus.idFocused || scopeFocus.tooltip !== 'hidden') throw new Error('Scope keyboard navigation: ' + JSON.stringify(scopeFocus))
    await click('.overview-session-id-toggle')
    if (!await contents.executeJavaScript(`!document.querySelector('.overview-session-full-id').hidden && document.querySelector('.overview-session-full-id').textContent === '01a10000-1111-7000-8000-00000000abcd'`)) throw new Error('Native ID expansion lost the full session ID')
    // Fake only the typed clipboard boundary: never overwrite the user's real clipboard.
    await contents.executeJavaScript(`window.scry.copyText = async text => { document.querySelector('#overview').dataset.copied = text; return true }; true`)
    await click('.overview-session-copy')
    if (!await contents.executeJavaScript(`document.querySelector('#overview').dataset.copied === '01a10000-1111-7000-8000-00000000abcd' && document.querySelector('.overview-session-notice[role="status"]').textContent === '已复制完整 sessionId'`)) throw new Error('Copy did not send the full ID through the typed boundary')
    await contents.executeJavaScript(`window.scry.copyText = async () => { throw new Error('fixture clipboard failure') }; true`)
    await click('.overview-session-copy')
    if (!await contents.executeJavaScript(`document.querySelector('.overview-session-notice[role="alert"]').textContent === '复制未完成，请展开 ID 后手动选择'`)) throw new Error('Copy failure was hidden or reported as success')
    await click('#overview-session-tab')
    if (!await contents.executeJavaScript(`document.querySelector('#overview-session-tab').getAttribute('aria-selected') === 'true' && !document.querySelector('#overview-session-panel').hidden && document.querySelector('#overview-turns-panel').hidden`)) {
      throw new Error('Overview native tab click did not select session data')
    }
    if (!await contents.executeJavaScript(`!document.querySelector('#overview-session-panel').textContent.includes('本会话 Token 用量') && !document.querySelector('#overview-session-panel .pstats') && document.querySelector('#overview-file-footprint') != null && document.querySelector('#overview .overview-metric-grid') != null`)) {
      throw new Error('Overview retained the redundant token section or removed adjacent evidence')
    }
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
    await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    if (!await contents.executeJavaScript(`document.activeElement.id === 'overview-turns-tab'`)) throw new Error('Overview keyboard focus did not reach turns tab')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    if (!await contents.executeJavaScript(`document.activeElement.id === 'overview-turns-tab' && !document.querySelector('#overview-turns-panel').hidden`)) throw new Error('Overview keyboard tab return failed')
    // Fixture controls change the session; the interactions above use native input.
    await contents.executeJavaScript(`document.querySelector('#context-start').click(); true`)
    await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (!await contents.executeJavaScript(`document.querySelector('.overview-session-full-id').hidden && !document.querySelector('.overview-session-notice') && document.querySelector('.overview-session-count').textContent === '0'`)) throw new Error('Session switch retained expanded ID, copy feedback or a stale count')
    await contents.executeJavaScript(`document.querySelector('#context-compact').click(); true`)
    // Busy summaries intentionally sample every 200 ms; wait for the observed count, not a fixed frame count.
    const countDeadline = Date.now() + 5000
    while (!await contents.executeJavaScript(`document.querySelector('.overview-session-count').textContent === '1'`)) {
      if (Date.now() > countDeadline) throw new Error('Confirmed compaction did not update the numeric count')
      await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))')
    }
    return results
  } finally { await contents.removeInsertedCSS(css) }
}
