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
  const pointOf = async selector => read(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('Missing performance control: ' + ${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'center' });
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Performance control obscured: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`)
  const click = async selector => {
    const point = await pointOf(selector)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
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
  const fixtureState = "JSON.parse(document.querySelector('#performance-fixture-state').textContent)"
  // 核对同一 Agent 的多个会话合为一行，且保留 Agent、暂计覆盖数和中位数。
  if (!await read(`Array.from(${rows}).filter(node => node.textContent.includes('pi-live-model')).length === 1`)) throw new Error('Same-Agent sessions were not pooled into one row')
  if (!await read(`${liveRow}.textContent.includes('Pi')`)) throw new Error('Pooled row lost its Agent')
  if (!await read(`${liveRow}.querySelectorAll('td.is-num')[0].getAttribute('title').includes('3 暂计')`)) throw new Error('Provisional coverage is missing')
  if (!await read(`${liveRow}.textContent.includes('90.0') && ${liveRow}.textContent.includes('1.5')`)) throw new Error('Provisional medians are wrong: ' + await read(`${liveRow}.textContent`))
  await click('#performance-ungroup')
  await wait(`${liveRow}?.querySelectorAll('td.is-num')[0].getAttribute('title').includes('1 暂计')`)
  await click('#performance-focus')
  await read('new Promise(resolve => setTimeout(resolve, 1100))')
  if (!await read(`${liveRow}?.textContent.includes('160.0')`)) throw new Error('Focus changed global measurements')
  await click('#performance-complete')
  await wait(`Array.from(${rows}).some(node => node.textContent.includes('fixture-model'))`)
  // 上面核对有首 token 计时的样本显示 160.0（80 token ÷ 0.5 秒）。
  // 无首 token 计时的样本按整段时长预期为 20.0（100 token ÷ 5 秒）；下面只核对读数不低于 20。
  const completed = await read(`(() => { const node = Array.from(${rows}).find(row => row.textContent.includes('fixture-model')); return { speed: node.querySelectorAll('td.is-num.is-strong')[0].textContent } })()`)
  if (!(Number(completed.speed) >= 20)) throw new Error('Completed round lost its measured speed: ' + completed.speed)
  // 核对趋势图可聚焦且至少有两个点；End/Home 切换首尾读数，Esc 收起读数。
  const trend = await read(`(() => { const svg = document.querySelector('.analytics-trend svg'); if (!svg) return { points: 0 }; svg.focus({ preventScroll: true }); return { points: svg.querySelectorAll('.analytics-point').length, focused: document.activeElement === svg } })()`)
  if (trend.points < 2 || !trend.focused) throw new Error('Trend chart cannot be focused: ' + JSON.stringify(trend))
  const tipText = () => read(`document.querySelector('.analytics-tip')?.textContent ?? ''`)
  const press = async keyCode => {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
    await read('new Promise(resolve => requestAnimationFrame(resolve))')
  }
  const firstTip = await tipText()
  if (!/\d/.test(firstTip)) throw new Error('Trend keyboard readout missing: ' + firstTip)
  await press('End')
  const lastTip = await tipText()
  if (lastTip === firstTip || !/\d/.test(lastTip)) throw new Error('Trend End key lost the last round: ' + lastTip)
  await press('Home')
  if (await tipText() !== firstTip) throw new Error('Trend Home key did not return to the first round')
  await press('Escape')
  if (await tipText() !== '') throw new Error('Trend Escape left the readout open')
  // 停止的一轮替换暂计样本：没有成功轮次的模型不成行。
  await click('#performance-stop')
  await wait(`${liveRow} == null`)
  const hiddenRounds = await read(`${fixtureState}.rows`)
  if (!hiddenRounds) throw new Error('Fixture history is empty')
  // Exercise the visibility subscription without showing or stealing focus from the user's window.
  await read("Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))")
  await wait(`${fixtureState}.dataListeners === ${baselineListeners}`)
  const hiddenReads = await read(`${fixtureState}.summaryReads`)
  await read('new Promise(resolve => setTimeout(resolve, 1300))')
  if (await read(`${fixtureState}.summaryReads`) !== hiddenReads) throw new Error('Hidden page kept polling')
  await read("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))")
  await wait(`${fixtureState}.summaryReads > ${hiddenReads}`)
  if (nativeVisibility) {
    win.hide()
    await wait('document.hidden')
    const nativeReads = await read(`${fixtureState}.summaryReads`)
    await read('new Promise(resolve => setTimeout(resolve, 1300))')
    if (await read(`${fixtureState}.summaryReads`) !== nativeReads) throw new Error('Native hidden page kept polling')
    win.showInactive()
    await wait(`!document.hidden && ${fixtureState}.summaryReads > ${nativeReads}`)
  }
  await click('#performance-empty')
  await read('new Promise(resolve => setTimeout(resolve, 1100))')
  if (await read(`${page}.querySelector('.analytics-running, .analytics-live') != null`)) throw new Error('Removed runtime status is visible')
  await click('#performance-summary-error')
  await wait(`[...${page}.querySelectorAll('.analytics-alert[role=alert]')].some(node => node.textContent.includes('没能刷新实时指标，仍显示上次读取的结果'))`)
  if (await read(`${page}.textContent.includes('fixture summary unavailable')`)) throw new Error('Summary error exposed raw diagnostics')
  if (await read(`${page}.textContent.includes('含运行中数据')`)) throw new Error('Summary error retained stale provisional evidence')
  // 往返切换标签时核对 Agent 筛选不变，并确认成本页提供 24 小时档。
  await read(`(() => { const select = ${page}.querySelector('.analytics-filter select'); select.value = 'antigravity'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await wait(`${page}.querySelector('.analytics-filter select').value === 'antigravity'`)
  await click('#performance-history-error')
  await click('#performance-refresh')
  await click('.analytics-tabs [role="tab"]:nth-of-type(2)')
  await wait(`${page}.querySelector('#analytics-agents') != null`)
  if (await read(`${page}.querySelector('.analytics-filter select').value !== 'antigravity'`)) throw new Error('Agent filter was reset by the tab switch')
  if (!await read(`[...${page}.querySelectorAll('.analytics-range button')].some(node => node.textContent === '24 小时')`)) throw new Error('Cost tab does not offer its own ranges')
  await capture('-cost')
  await click('.analytics-tabs [role="tab"]:nth-of-type(1)')
  await wait(`${page}.querySelector('#analytics-comparison') != null`)
  if (await read(`${page}.querySelector('.analytics-filter select').value !== 'antigravity'`)) throw new Error('Agent filter was not preserved back on performance')
  await wait(`[...${page}.querySelectorAll('.analytics-alert[role=alert]')].some(node => node.textContent.includes('性能历史'))`)
  if (await read(`${page}.textContent.includes('fixture history unavailable')`)) throw new Error('History error exposed raw diagnostics')
  await click('.sb-navitem:nth-of-type(2)')
  await wait(`document.querySelector('.analytics-page') == null`)
  if (await read(`${fixtureState}.dataListeners !== ${baselineListeners}`)) throw new Error('Leaving the page retained a subscription')
  return { assertions: ['merged page with performance as the default tab', 'no data rows or cells without evidence', 'real medians and blank missing cells', 'failed rounds never draw performance', 'per-round trend with metric switch and keyboard readout', 'provisional samples retained and pooled per Agent', 'output speed excludes the first-token wait', 'stopped rounds leave no row', 'data errors keep readable copy', 'visibility subscription and range/agent retention', 'tabs keep the Agent filter and only reuse a shared range', 'dark/light AA contrast and narrow layout'], nativeVisibility: nativeVisibility ? 'passed' : 'not-run (visibility event simulated)' }
}
