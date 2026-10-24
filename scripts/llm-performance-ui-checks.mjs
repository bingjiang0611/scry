export async function exerciseLlmPerformanceFinish(contents, win, screenshot, nativeVisibility, baselineListeners) {
  const read = expression => contents.executeJavaScript(expression)
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error('LLM performance timed out: ' + expression + '; ' + await read('document.body.innerText'))
      // Not requestAnimationFrame: it never fires while the window is hidden, which would hang the hidden-window check.
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  }
  const pointOf = async (selector, fraction = 0.5) => read(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing performance control: ' + ${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width * ${fraction}), y = Math.round(rect.top + rect.height / 2);
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Performance control obscured: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`)
  const click = async selector => {
    const point = await pointOf(selector)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const hover = async (selector, fraction) => contents.sendInputEvent({ type: 'mouseMove', ...await pointOf(selector, fraction) })
  const key = code => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: code })
    if (code === 'Return') contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: code })
  }
  const capture = async (suffix, end = false) => {
    if (!screenshot) return
    await read(`document.querySelector('#performance-fixture-controls').style.visibility = 'hidden'; document.querySelector('.llm-perf-body').scrollTop = ${end ? "document.querySelector('.llm-perf-body').scrollHeight" : '0'}; document.documentElement.scrollTop = 0; document.body.scrollTop = 0; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    try {
      const bounds = await read(`(() => { const r = document.querySelector('.llm-perf-modal').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`)
      require('node:fs').writeFileSync(screenshot + suffix + '.png', (await contents.capturePage(bounds, { stayHidden: true, stayAwake: true })).toPNG())
    } finally {
      await read(`document.querySelector('#performance-fixture-controls').style.visibility = ''`)
    }
  }
  const modal = `document.querySelector('.llm-perf-modal')`
  const liveRow = `Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).find(node => node.textContent.includes('pi-live-model'))`
  await click('#performance-group')
  await wait(`${liveRow}?.textContent.includes('0 + 3*') && ${liveRow}.querySelectorAll('.llm-perf-reading')[0].textContent === '40.0' && ${liveRow}.querySelectorAll('.llm-perf-reading')[1].textContent === '1.5'`)
  if (await read(`${modal}.querySelector('.llm-perf-run') != null`)) throw new Error('Running cards reappeared')
  await click('.llm-perf-notices details:first-child summary')
  await wait(`${modal}.querySelector('.llm-perf-notices details').open`)
  if (!await read(`${modal}.querySelector('.llm-perf-notices p').textContent.includes('最终记录替换')`)) throw new Error('Provisional evidence lacks replacement explanation')
  key('Return')
  await wait(`!${modal}.querySelector('.llm-perf-notices details').open`)
  const contrastByTheme = {}
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`)
    contrastByTheme[theme] = await read(`(() => {
      const luminance = color => color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const nodes = Array.from(${modal}.querySelectorAll('.llm-perf-mname, .llm-perf-mname small, .llm-perf-reading, .llm-perf-unit, .llm-perf-axis text, .llm-perf-mhead > span, .llm-perf-help summary'))
      return Math.min(...nodes.map(node => {
        const style = getComputedStyle(node)
        const foreground = luminance(node instanceof SVGElement ? style.fill : style.color)
        let parent = node
        while (getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement
        const background = luminance(getComputedStyle(parent).backgroundColor)
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
      }))
    })()`)
    if (contrastByTheme[theme] < 4.5) throw new Error('Performance labels lack AA text contrast in ' + theme + ': ' + contrastByTheme[theme])

    if (!await read(`Array.from(${modal}.querySelectorAll('.llm-perf-reading')).every(node => parseFloat(getComputedStyle(node).fontSize) === 21)`)) throw new Error('Metric typography differs from approved draft')
    await capture('-comparison-' + theme)
  }
  for (const width of [700, 520]) {
    win.setSize(width, 800)
    await wait(`innerWidth === ${width}`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (!await read(`${modal}.querySelector('.llm-perf-body').scrollWidth <= ${modal}.querySelector('.llm-perf-body').clientWidth && ${modal}.scrollWidth <= ${modal}.clientWidth`)) throw new Error('Comparison overflow escaped local scroll container')
    await click('.llm-perf-notices details:first-child summary')
    await wait(`${modal}.querySelector('.llm-perf-notices details').open`)
    if (!await read(`(() => { const body = ${modal}.querySelector('.llm-perf-body').getBoundingClientRect(); const help = ${modal}.querySelector('.llm-perf-notices details p').getBoundingClientRect(); return help.left >= body.left && help.right <= body.right })()`)) throw new Error('Narrow provisional explanation clipped')
    key('Return')
    await capture('-narrow-' + width)
  }
  win.setSize(1000, 800)
  await wait('innerWidth === 1000')
  await read("document.documentElement.dataset.theme = 'dark'")
  await click('#performance-ungroup')
  await wait(`${liveRow}?.textContent.includes('0 + 1*')`)
  await click('#performance-focus')
  await read('new Promise(resolve => setTimeout(resolve, 1100))')
  if (!await read(`${liveRow}?.textContent.includes('40.0')`)) throw new Error('Focus changed global measurements')
  await click('#performance-complete')
  await wait(`Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).some(node => node.textContent.includes('fixture-model') && node.textContent.includes('20.0'))`)
  // Select the live model through its actual row before it disappears.
  const liveIndex = await read(`Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).findIndex(node => node.textContent.includes('pi-live-model')) + 1`)
  await click('.llm-perf-mrow:nth-of-type(' + liveIndex + ')')
  await wait(`${modal}.querySelector('.llm-perf-detail-title').textContent === 'pi-live-model'`)
  await click('#performance-stop')
  await wait(`!${liveRow} && ${modal}.querySelector('.llm-perf-detail-title').textContent === 'fast-model'`)
  const fixtureState = "JSON.parse(document.querySelector('#performance-fixture-state').textContent)"
  // Exercise the visibility subscription without showing or stealing focus from the user's window.
  await read("Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))")
  await wait(`${fixtureState}.dataListeners === ${baselineListeners}`)
  const hiddenReads = await read(`${fixtureState}.summaryReads`)
  await read('new Promise(resolve => setTimeout(resolve, 1300))')
  if (await read(`${fixtureState}.summaryReads`) !== hiddenReads) throw new Error('Hidden modal kept polling')
  await read("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))")
  await wait(`${fixtureState}.summaryReads > ${hiddenReads}`)
  if (nativeVisibility) {
    win.hide()
    await wait('document.hidden')
    const nativeReads = await read(`${fixtureState}.summaryReads`)
    await read('new Promise(resolve => setTimeout(resolve, 1300))')
    if (await read(`${fixtureState}.summaryReads`) !== nativeReads) throw new Error('Native hidden modal kept polling')
    win.showInactive()
    await wait(`!document.hidden && ${fixtureState}.summaryReads > ${nativeReads}`)
  }
  await click('#performance-empty')
  await read('new Promise(resolve => setTimeout(resolve, 1100))')
  if (await read(`${modal}.querySelector('.llm-perf-run, .llm-perf-live') != null`)) throw new Error('Removed runtime status is visible')
  await click('#performance-summary-error')
  await wait(`${modal}.textContent.includes('运行中数据读取失败：fixture summary unavailable')`)
  if (await read(`${modal}.textContent.includes('含运行中数据')`)) throw new Error('Summary error retained stale provisional evidence')
  await click('.modal-x')
  await wait(`${modal} == null`)
  const closedReads = await read(`${fixtureState}.summaryReads`)
  await read('new Promise(resolve => setTimeout(resolve, 1300))')
  if (await read(`${fixtureState}.summaryReads`) !== closedReads || await read(`${fixtureState}.dataListeners`) !== baselineListeners) throw new Error('Closed modal retained polling or subscription')
  if (!await read("document.activeElement?.title === 'LLM 性能'")) throw new Error('Close did not restore launcher focus')
  await click('#performance-history-error')
  await click('.sb-navitem[title="LLM 性能"]')
  await wait(`${modal}?.textContent.includes('fixture history unavailable')`)
  if (await read(`${modal}.querySelector('.llm-perf-mrow, .llm-perf-chart') != null`)) throw new Error('History error retained apparently successful measurements')
  await click('.modal-x')
  return { assertions: ['four-column distribution-first layout', 'running cards and smoothed curves removed', 'independent real medians and missing evidence', 'failed rounds excluded', 'full distribution accessible', 'model selection and disappearance fallback', 'metric and range switches', 'measured interval tooltip and keyboard navigation', 'provisional completed-call samples retained', 'cross-provider model pooling omits missing evidence', 'focus-independent source', 'completion/stop refresh', 'read errors clear stale evidence', 'visibility subscription and close stop polling', 'close restores focus', 'dark/light AA contrast', 'local narrow scroll and help containment'], nativeVisibility: nativeVisibility ? 'passed' : 'not-run (visibility event simulated)', contrastByTheme }
}
