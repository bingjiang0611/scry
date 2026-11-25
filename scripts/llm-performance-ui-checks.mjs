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
  // 同一 Agent 的多个会话在表里是一行；暂计样本保留，但轮次按实际轮数计。
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
  // Q8 的证据在上面：有首 token 计时的样本按生成时间算（80 token ÷ 0.5 秒 = 160.0），
  // 没有首 token 计时的轮次只能按整段时长算（100 ÷ 5 秒 = 20.0），不能凭空扣除等待。
  const completed = await read(`(() => { const node = Array.from(${rows}).find(row => row.textContent.includes('fixture-model')); return { speed: node.querySelectorAll('td.is-num.is-strong')[0].textContent } })()`)
  if (!(Number(completed.speed) >= 20)) throw new Error('Completed round lost its measured speed: ' + completed.speed)
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
  // 标签切换保留 Agent 筛选；时间范围只在另一页也有同一档时沿用。
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
  return { assertions: ['merged page with performance as the default tab', 'no data rows or cells without evidence', 'real medians and blank missing cells', 'failed rounds never draw performance', 'per-round trend with metric switch', 'provisional samples retained and pooled per Agent', 'output speed excludes the first-token wait', 'stopped rounds leave no row', 'data errors keep readable copy', 'visibility subscription and range/agent retention', 'tabs keep the Agent filter and only reuse a shared range', 'dark/light AA contrast and narrow layout'], nativeVisibility: nativeVisibility ? 'passed' : 'not-run (visibility event simulated)' }
}
