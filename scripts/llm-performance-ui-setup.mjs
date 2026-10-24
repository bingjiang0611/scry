export async function exerciseLlmPerformanceSetup(contents, win, screenshot, nativeVisibility) {
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
  if (nativeVisibility) win.showInactive()
  contents.focus()
  await wait(`document.querySelector('.sb-navitem[title="LLM 性能"]') != null`)
  const nav = await read(`Array.from(document.querySelectorAll('.sb-navitem')).map(node => node.textContent.trim())`)
  if (nav.indexOf('LLM 性能') !== 1 || nav.indexOf('技能') !== 2) throw new Error('LLM 性能 entry is not directly above Skills')
  const baselineListeners = await read(`JSON.parse(document.querySelector('#performance-fixture-state').textContent).dataListeners`)
  await click('.sb-navitem[title="LLM 性能"]')
  await wait(`document.querySelector('.llm-perf-modal') != null`)
  const modal = `document.querySelector('.llm-perf-modal')`
  await wait(`${modal}.querySelectorAll('.llm-perf-mrow').length === 2 && ${modal}.querySelectorAll('.llm-perf-interval').length > 0`)
  if (await read(`${modal}.querySelector('.llm-perf-running, .llm-perf-run, .llm-perf-line') != null`)) throw new Error('Removed running cards or smooth curves remain')
  const readings = await read(`Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).map(node => ({model: node.querySelector('b').textContent, values: [...node.querySelectorAll('.llm-perf-reading')].map(n => n.textContent)}))`)
  if (JSON.stringify(readings) !== JSON.stringify([{model: 'fast-model', values: ['62.0','2.0']}, {model: 'slow-model', values: ['21.0','—']}])) throw new Error('Real comparison medians/missing evidence wrong: '+JSON.stringify(readings))
  if (!await read(`${modal}.querySelector('.llm-perf-mrow').children.length === 4 && ${modal}.querySelector('.llm-perf-detail-title').textContent === 'fast-model'`)) throw new Error('Four-column comparison or default selection wrong')
  if (await read(`${modal}.textContent.includes('999') || ${modal}.textContent.includes('unmeasured-model') || ${modal}.textContent.includes('字符/s')`)) throw new Error('Failed/missing history or legacy character units leaked')
  const range = await read(`${modal}.querySelector('.llm-perf-distribution').getAttribute('aria-label')`)
  if (!range.includes('最小 60.0') || !range.includes('最大 64.0') || !range.includes('P25')) throw new Error('Distribution missing accessible full range')
  await click('.llm-perf-notices summary')
  await wait(`${modal}.querySelector('.llm-perf-notices details').open`)
  if (!await read(`document.activeElement.matches('.llm-perf-help summary') && ${modal}.querySelector('.llm-perf-notices p').textContent.includes('少于 3 轮')`)) throw new Error('Accessible distribution explanation missing')
  key('Return')
  await wait(`!${modal}.querySelector('.llm-perf-notices details').open`)
  if (!await read(`${modal}.contains(document.activeElement) && ${modal}.getAttribute('role') === 'dialog' && ${modal}.getAttribute('aria-modal') === 'true' && ${modal}.getAttribute('aria-labelledby')`)) throw new Error('Dialog focus/semantics broken')
  await hover('.llm-perf-interval .llm-perf-hit', .5)
  await wait(`${modal}.querySelector('.llm-perf-tip')?.textContent.includes('token/s')`)
  if (await read(`${modal}.querySelector('.llm-perf-tip').textContent.includes('空闲')`)) throw new Error('Idle synthesized into measured interval')
  await capture('-dark')
  await click('.llm-perf-mrow:nth-of-type(2)')
  await wait(`${modal}.querySelector('.llm-perf-detail-title').textContent === 'slow-model'`)
  await click('.llm-perf-metric button:nth-child(2)')
  await wait(`${modal}.querySelector('.llm-perf-empty')?.textContent.includes('slow-model') && ${modal}.querySelector('.llm-perf-empty').textContent.includes('首 token') && !${modal}.querySelector('.llm-perf-chart svg')`)
  await click('.llm-perf-mrow:nth-of-type(1)')
  await wait(`${modal}.querySelectorAll('.llm-perf-interval').length > 0 && ${modal}.querySelector('.llm-perf-unit').textContent === '秒'`)
  await hover('.llm-perf-interval .llm-perf-hit', .5)
  await wait(`${modal}.querySelector('.llm-perf-tip')?.textContent.includes('秒')`)
  await click('.llm-perf-mrow:nth-of-type(1)')
  if (!await read(`${modal}.querySelector('.llm-perf-mrow').getAttribute('aria-pressed') === 'true'`)) throw new Error('Repeated model click deselected detail')
  await click('.llm-perf-metric button:nth-child(1)')
  await wait(`${modal}.querySelector('.llm-perf-chart svg') != null && ${modal}.querySelector('.llm-perf-unit').textContent === 'token/s'`)
  await click('.llm-perf-chart svg')
  key('Home')
  await wait(`${modal}.querySelector('.llm-perf-interval:first-of-type.active') != null || ${modal}.querySelector('.llm-perf-tip') != null`)
  key('End')
  await wait(`${modal}.querySelector('.llm-perf-interval:last-child.active') != null`)
  key('Left')
  if (!await read(`document.activeElement.matches('.llm-perf-chart svg') && ${modal}.querySelector('.llm-perf-tip') != null`)) throw new Error('Keyboard chart navigation lost focus')
  key('Escape')
  await wait(`${modal} != null && ${modal}.querySelector('.llm-perf-tip') == null`)
  await click('.llm-perf-range button:nth-child(1)')
  await wait(`${modal}.querySelector('.llm-perf-range button').getAttribute('aria-pressed') === 'true' && ${modal}.querySelector('.llm-perf-mrow .llm-perf-reading').textContent === '61.0'`)
  await click('.llm-perf-range button:nth-child(3)')
  await wait(`${modal}.querySelector('.llm-perf-mrow .llm-perf-reading').textContent === '62.0'`)
  await click('.llm-perf-range button:nth-child(2)')
  await click('#performance-stream')
  await wait(`Array.from(${modal}.querySelectorAll('.llm-perf-mrow')).some(node => node.textContent.includes('pi-live-model') && node.textContent.includes('40.0') && node.textContent.includes('1.5') && node.textContent.includes('0 + 1*'))`)
  if (await read(`${modal}.querySelector('.llm-perf-running, .llm-perf-run') != null`)) throw new Error('Live evidence restored removed cards')
  return { baselineListeners }
}
