// Native input and layout checks run in the isolated Electron fixture.
export async function exerciseNative(contents, win, query, screenshotDir) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (fn, argument) => contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
  const frame = () => read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const click = async (selector, label) => {
    const point = await read(({ selector, label }) => {
      const node = [...document.querySelectorAll(selector)].find(node => !label || node.textContent === label)
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    }, { selector, label })
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await frame()
  }
  const key = async (keyCode) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
    await frame()
  }
  const hover = async (index, count, focus = false) => {
    const point = await read(({ index, count }) => {
      const node = document.querySelector('.usage-chart')
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      const grid = node.querySelector('line')
      const x = grid.x1.baseVal.value + index / (count - 1) * (grid.x2.baseVal.value - grid.x1.baseVal.value)
      return { x: Math.round(rect.x + x / node.viewBox.baseVal.width * rect.width), y: Math.round(rect.y + rect.height * 0.4) }
    }, { index, count })
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    if (focus) {
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }
    await frame()
  }
  const tooltip = () => read(() => {
    const node = document.querySelector('.usage-chart-tooltip')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const plot = document.querySelector('.usage-chart').getBoundingClientRect()
    return { day: node.querySelector('b').textContent, text: node.textContent,
      evidence: [...node.querySelectorAll('strong')].map(value => value.title).join('; '),
      explanations: node.querySelectorAll('small').length,
      circles: document.querySelectorAll('.usage-chart-hover circle').length,
      contained: rect.left >= plot.left && rect.right <= plot.right }
  })
  const date = day => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00`))
  const data = await query(7)
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(data) + ')')
  await frame()
  await hover(data.days.length - 3, data.days.length, true)
  let detail = await tooltip()
  check(detail.day === date(data.days.at(-3)), 'Pointer focus replaced hovered day with last day')
  check(detail.text.includes('$0.00') && detail.evidence.includes('当日无记录') && detail.circles === 1, 'Measured zero and missing day are conflated')
  check(detail.contained, 'Hover tooltip overflows plot')
  check(detail.explanations === 0 && !detail.text.includes('当日无记录'), 'Chart tooltip retained long explanation rows')
  await key('Right')
  detail = await tooltip()
  check(detail.day === date(data.days.at(-2)) && detail.circles === 0 && detail.evidence.includes('当日无记录'), 'Arrow key lost missing-day semantics')
  await key('Home')
  detail = await tooltip()
  check(detail.day === date(data.days[0]) && detail.contained, 'Home/left-edge tooltip failed')
  await key('End')
  detail = await tooltip()
  check(detail.day === date(data.days.at(-1)) && detail.contained && detail.evidence.includes('已知下界') && detail.text.includes('≈'), 'End/right-edge compact estimate tooltip failed')
  await key('Escape')
  check(await tooltip() === null, 'Escape did not dismiss chart details')
  await hover(data.days.length - 1, data.days.length)
  contents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
  await frame()
  check(await tooltip() === null, 'Pointer leave did not dismiss chart details')
  await click('[aria-label="趋势指标"] button', 'TOKEN')
  check(await read(() => document.querySelector('.usage-chart').getAttribute('aria-label')) === '每日 Token 趋势', 'Native metric switch missed')
  await click('[aria-label="明细维度"] button', '日期')
  check(await read(() => document.querySelector('.usage-table-wrap thead th').textContent) === '日期', 'Native day switch missed')
  await click('[aria-label="明细维度"] button', '模型')
  await click('[aria-label="趋势指标"] button', '成本')
  await click('[aria-label="分析时间范围"] button', '90 天')
  const long = await query(90)
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(long) + ')')
  await frame()
  await hover(long.days.length - 1, long.days.length, true)
  await click('[aria-label="分析时间范围"] button', '7 天')
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(data) + ')')
  await frame()
  check(await read(() => document.querySelector('.usage-cost-card > strong').textContent) === '$1.41' && await tooltip() === null, 'Shorter range retained stale hover index')
  await click('[aria-label="刷新分析数据"]')
  check(await read(() => document.querySelector('#fixture-status').dataset.refreshes) === '2', 'Native refresh missed')
  const layouts = []
  for (const [width, theme] of [[1512, 'dark'], [1100, 'dark'], [620, 'dark'], [1512, 'light']]) {
    win.setContentSize(width, 1000)
    await read(theme => { document.documentElement.dataset.theme = theme; document.querySelector('.usage-page').scrollTop = 0 }, theme)
    contents.invalidate()
    await frame()
    const layout = await read(() => {
      const chart = document.querySelector('.usage-chart-card').getBoundingClientRect()
      const providers = document.querySelector('.usage-provider-panel').getBoundingClientRect()
      const background = getComputedStyle(document.querySelector('.usage-page')).backgroundColor
      const luminance = color => {
        const channels = color.match(/\d+/g).slice(0, 3).map(value => {
          const channel = Number(value) / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const textLuminance = luminance(getComputedStyle(document.querySelector('.usage-metrics dt')).color)
      const backgroundLuminance = luminance(background)
      const labelContrast = (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05)
      return { width: innerWidth, background, labelContrast,
        noOverflow: document.querySelector('.usage-page').scrollWidth <= innerWidth,
        chartLeft: chart.right <= providers.left, stacked: chart.bottom <= providers.top,
        smooth: [...document.querySelectorAll('.usage-chart-line')].every(path => path.getAttribute('d').includes(' C ')),
        visibleSeries: [...document.querySelectorAll('.usage-chart-line')].every(path => getComputedStyle(path).stroke !== 'none') }
    })
    check(layout.background === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(13, 13, 12)'), 'Theme was not applied: ' + JSON.stringify(layout))
    check(layout.labelContrast >= 4.5, 'Secondary labels fail normal-text contrast: ' + JSON.stringify(layout))
    check(layout.noOverflow && layout.smooth && layout.visibleSeries, 'Layout/curve regression: ' + JSON.stringify(layout))
    check(width > 920 ? layout.chartLeft : layout.stacked, 'Chart/provider order differs from design')
    if (screenshotDir) {
      const image = await contents.capturePage({ x: 0, y: 0, width, height: 1000 }, { stayHidden: true, stayAwake: true })
      require('node:fs').writeFileSync(require('node:path').join(screenshotDir, `usage-${width}-${theme}.png`), image.toPNG())
    }
    layouts.push({ width, theme, ...layout })
  }
  return { nativePointer: true, nativeKeyboard: true, nativeControls: true, zeroVsMissing: true, shorterRange: true, layouts }
}
