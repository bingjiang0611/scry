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
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (!nodes.length) throw new Error('Missing performance control: ' + ${JSON.stringify(selector)});
    const attempts = [];
    for (const node of nodes) {
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width * ${fraction}), y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (node.contains(hit)) return { x, y };
      attempts.push({ x, y, rect: rect.toJSON(), hit: hit?.outerHTML.slice(0, 300) });
    }
    throw new Error('Performance control obscured: ' + ${JSON.stringify(selector)} + '; geometry=' + JSON.stringify({ matched: nodes.length, first: attempts[0], last: attempts[attempts.length - 1], viewport: [innerWidth, innerHeight] }));
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
    await read(`document.querySelector('#performance-fixture-controls').style.visibility = 'hidden'; document.querySelector('.analytics-page').scrollTop = ${end ? "document.querySelector('.analytics-page').scrollHeight" : '0'}; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    try {
      const bounds = await read(`(() => { const r = document.querySelector('.analytics-page').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`)
      require('node:fs').writeFileSync(screenshot + suffix + '.png', (await contents.capturePage(bounds, { stayHidden: true, stayAwake: true })).toPNG())
    } finally {
      await read(`document.querySelector('#performance-fixture-controls').style.visibility = ''`)
    }
  }
  const page = `document.querySelector('.analytics-page')`
  const rows = `${page}.querySelectorAll('.analytics-table.is-models tbody tr')`
  const liveRow = `Array.from(${rows}).find(node => node.textContent.includes('pi-live-model'))`
  if (nativeVisibility) win.showInactive()
  contents.focus()
  await wait(`document.querySelector('.sb-navitem') != null`)
  const nav = await read(`Array.from(document.querySelectorAll('.sb-navitem')).map(node => node.textContent.trim())`)
  if (nav.indexOf('分析') !== 0) throw new Error('Analytics entry is not first: ' + JSON.stringify(nav))
  if (nav.includes('LLM 性能')) throw new Error('The removed LLM performance entry is still in the sidebar')
  const baselineListeners = await read(`JSON.parse(document.querySelector('#performance-fixture-state').textContent).dataListeners`)
  await click('.sb-navitem:nth-of-type(1)')
  await wait(`${page} != null`)
  if (await read(`document.querySelector('.llm-perf-modal') != null`)) throw new Error('The removed performance modal reopened')
  if (!await read(`[...${page}.querySelectorAll('.analytics-tabs [role="tab"]')].map(node => node.textContent).join(',') === 'LLM 性能,成本与用量'`)) throw new Error('Tabs differ from design')
  if (!await read(`[...${page}.querySelectorAll('.analytics-tabs [role="tab"]')].map(node => node.getAttribute('aria-selected')).join(',') === 'true,false'`)) throw new Error('LLM performance is not the default tab')
  await wait(`${rows}.length === 4`)
  if (await read(`${page}.querySelector('.analytics-running, .analytics-line, .analytics-card .llm-perf-running') != null`)) throw new Error('Removed running cards or smooth curves remain')
  const readings = await read(`Array.from(${rows}).map(node => ({ model: node.querySelector('b').textContent, turns: node.querySelectorAll('td.is-num')[0].firstChild.textContent.trim(), values: [...node.querySelectorAll('td.is-num.is-strong')].map(cell => cell.textContent) }))`)
  const expected = [
    { model: 'fast-model', turns: '5', values: ['62.0', '2.0', ''] },
    { model: 'slow-model', turns: '3', values: ['21.0', '', ''] },
    { model: 'model-agy', turns: '1', values: ['', '', '14.0'] },
    { model: 'unmeasured-model', turns: '1', values: ['', '', ''] }
  ]
  if (JSON.stringify(readings) !== JSON.stringify(expected)) throw new Error('Real comparison medians/missing evidence wrong: ' + JSON.stringify(readings))
  // 表头带单位，页面不出现「—」「所选：」。
  if (!await read(`${page}.querySelector('.analytics-table.is-models thead').textContent.includes('token/秒')`)) throw new Error('Speed column lost its unit')
  if (await read(`/—|所选：/.test(${page}.textContent)`)) throw new Error('Placeholder dash or removed model label is visible')
  if (!await read(`${page}.querySelectorAll('.analytics-table.is-models thead th').length === 6`)) throw new Error('Comparison columns differ from design')
  if (await read(`${page}.querySelector('.analytics-models-summary, .analytics-table-unit') != null`)) throw new Error('Removed metric summary remains')
  if (await read(`${page}.textContent.includes('999') || ${page}.textContent.includes('字符/s')`)) throw new Error('Unsuccessful timing or legacy character units leaked')
  if (!await read(`${liveRow} == null`)) throw new Error('Live session rows appeared before data arrived')
  // 第三个模型只有首段回复证据；切换模型后曲线随指标走。
  await click(`.analytics-table.is-models tbody tr:nth-child(3) .analytics-row-select`)
  await wait(`${page}.querySelector('#analytics-trend').textContent.includes('model-agy')`)
  if (!await read(`${page}.querySelector('#analytics-trend').parentElement.textContent.includes('1 轮 · 每点一轮')`)) throw new Error('Trend card lost its per-round note')
  await click('.analytics-metric button:nth-of-type(3)')
  await wait(`${page}.querySelector('.analytics-trend svg')?.getAttribute('aria-label').includes('首段回复')`)
  if (!await read(`${page}.querySelector('.analytics-trend svg').getAttribute('aria-label').includes('每轮一个点')`)) throw new Error('Trend chart lost its per-round basis')
  if (!await read(`${page}.querySelectorAll('.analytics-point').length === 1`)) throw new Error('Trend chart drew more than one round')
  const basis = await read(`(() => { const details = ${page}.querySelector('.analytics-basis'); return { open: details.open, visible: details.querySelector('p').checkVisibility(), text: details.querySelector('p').textContent } })()`)
  if (basis.open || basis.visible) throw new Error('Metric basis is not collapsed by default: ' + JSON.stringify(basis))
  if (!basis.text.includes('包含工具执行和等待你批准的时间') || !basis.text.includes('不含首 token 之前的等待')) throw new Error('Metric basis lost its definitions')
  await click(`.analytics-table.is-models tbody tr:nth-child(1) .analytics-row-select`)
  await wait(`${page}.querySelector('.analytics-trend svg')?.getAttribute('aria-label').includes('输出速度')`)
  const range = await read(`[...${page}.querySelectorAll('.analytics-table.is-models .analytics-dist')].map(node => node.getAttribute('aria-label')).join(' | ')`)
  if (!range.includes('最小 60.0') || !range.includes('最大 64.0') || !range.includes('P25')) throw new Error('Distribution missing accessible full range')
  if (await read(`${page}.querySelector('.analytics-basis summary') == null`)) throw new Error('Metric basis entry is missing')
  await hover('.analytics-point', .5)
  await wait(`${page}.querySelector('.analytics-tip')?.textContent.includes('token/秒')`)
  if (await read(`${page}.querySelector('.analytics-tip').textContent.includes('空闲')`)) throw new Error('Idle synthesized into measured round')
  await capture('-dark')
  const contrastByTheme = {}
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`)
    contrastByTheme[theme] = await read(`(() => {
      const luminance = color => color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const nodes = Array.from(${page}.querySelectorAll('.analytics-name, .analytics-sub, .analytics-tile-label, .analytics-axis text, .analytics-table thead th, .analytics-basis summary'))
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
    if (!await read(`parseFloat(getComputedStyle(${page}.querySelector('.analytics-trend > svg')).height) === 200`)) throw new Error('Trend chart does not use the design plot height')
    await capture('-comparison-' + theme)
  }
  for (const width of [700, 520]) {
    win.setSize(width, 800)
    await wait(`innerWidth === ${width}`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (!await read(`${page}.scrollWidth <= innerWidth && ${page}.querySelector('.analytics-table-scroll').scrollWidth >= ${page}.querySelector('.analytics-table-scroll').clientWidth`)) throw new Error('Comparison overflow escaped its scroll container')
    if (await read(`${page}.querySelector('.analytics-basis') == null`)) throw new Error('Metric basis vanished at narrow width')
    await capture('-narrow-' + width)
  }
  win.setSize(1000, 800)
  await wait('innerWidth === 1000')
  await read("document.documentElement.dataset.theme = 'dark'")
  // 时间范围只切换同一份数据的视图：1 小时窗口里只剩最近三轮。
  await click('.analytics-range button:nth-child(1)')
  await wait(`[...${rows}][0].querySelectorAll('td.is-num.is-strong')[0].textContent === '61.0'`)
  await click('.analytics-range button:nth-child(2)')
  await wait(`[...${rows}][0].querySelectorAll('td.is-num.is-strong')[0].textContent === '62.0'`)
  await click('#performance-stream')
  await wait(`Array.from(${rows}).some(node => node.textContent.includes('pi-live-model') && node.textContent.includes('160.0') && node.textContent.includes('1.5'))`)
  await click('#performance-group')
  await wait(`${liveRow} != null && ${liveRow}.querySelectorAll('td.is-num')[0].getAttribute('title').includes('3 暂计')`)
  if (await read(`${liveRow}.querySelectorAll('.analytics-dist').length !== 1`)) throw new Error('Provisional samples lost their distribution')
  return { baselineListeners, contrastByTheme }
}
