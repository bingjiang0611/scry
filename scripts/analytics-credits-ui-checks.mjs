// Native input and layout checks run in the isolated Electron fixture.
export async function exerciseNative(contents, win, query, screenshotDir) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const read = (fn, argument) => contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
  const frame = () => read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const until = async (source) => {
    const deadline = Date.now() + 5000
    while (!await contents.executeJavaScript(source)) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + source)
      await frame()
    }
  }
  const click = async (selector, label) => {
    const point = await read(({ selector, label }) => {
      const node = [...document.querySelectorAll(selector)].find(node => !label || node.textContent === label)
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    }, { selector, label })
    contents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 })
    await frame()
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    await frame()
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await frame()
  }
  const key = async (keyCode) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
    await frame()
  }
  const hoverDay = async (index, count) => {
    const point = await read(({ index, count }) => {
      const node = document.querySelector('.analytics-chart svg')
      node.scrollIntoView({ block: 'center' })
      // 键盘操作只在图表拿到焦点后才成立；悬停日保留，不因聚焦跳回第一天。
      node.focus({ preventScroll: true })
      const rect = node.getBoundingClientRect()
      const box = node.viewBox.baseVal
      const plotLeft = 56, plotRight = box.width - 12
      const x = count === 1 ? (plotLeft + plotRight) / 2 : plotLeft + index / (count - 1) * (plotRight - plotLeft)
      return { x: Math.round(rect.x + x / box.width * rect.width), y: Math.round(rect.y + rect.height * 0.5) }
    }, { index, count })
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    // 隐藏窗口没有合成帧，Chromium 只把按键和点击送进渲染进程，指针移动会被丢掉。
    // 点击路径仍走原生输入；这里按同一坐标补一个页内 pointermove，让图表收到指针位置。
    await read((point) => {
      const hit = document.elementFromPoint(point.x, point.y)
      hit?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: point.x, clientY: point.y, pointerType: 'mouse' }))
    }, point)
    await frame()
  }
  const readout = () => read(() => {
    const node = document.querySelector('.analytics-readout')
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const plot = document.querySelector('.analytics-chart').getBoundingClientRect()
    return { text: node.textContent, contained: rect.left >= plot.left - 1 && rect.right <= plot.right + 1 }
  })
  // 图表日期刻度跟随界面语言（zh-CN）。
  const day = value => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`))
  const data = await query(7)
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(data) + ')')
  await frame()
  await click('.analytics-tabs [role="tab"]', '成本与用量')
  await until(`document.querySelector('.analytics-tile.is-hero .analytics-tile-value')?.textContent === '$1.41'`)
  check(await read(() => document.querySelector('.analytics-tile.is-hero .analytics-tile-value').textContent) === '$1.41', 'Credits conversion is missing from the hero tile')
  await hoverDay(data.days.length - 3, data.days.length)
  let detail = await readout()
  check(detail?.text.startsWith(day(data.days.at(-3))), 'Pointer hover did not select the hovered day')
  check(/：/.test(detail.text), 'Readout lost its values')
  // 测到的 0 与拿不到价格是两回事：没有活动的日子画 0，全是未定价轮次的日子写「无价格」。
  const idle = data.days.length - 2
  await hoverDay(idle, data.days.length)
  const idleText = (await readout()).text
  check(/Pi \$0(\.00)?/.test(idleText), 'An idle day stopped plotting 0: ' + idleText)
  const unpriced = data.days.length - 4
  await hoverDay(unpriced, data.days.length)
  const unpricedText = (await readout()).text
  check(/Pi 无价格/.test(unpricedText), 'An unpriced-only day was written as a number: ' + unpricedText)
  await hoverDay(data.days.length - 3, data.days.length)
  detail = await readout()
  check(detail.contained, 'Readout overflows the chart')
  await key('Right')
  detail = await readout()
  check(detail.text.startsWith(day(data.days.at(-2))) && /：/.test(detail.text), 'Arrow key lost the previous-day readout: ' + detail.text)
  await key('Home')
  detail = await readout()
  check(detail.text.startsWith(day(data.days[0])) && detail.contained, 'Home/left-edge readout failed')
  await key('End')
  detail = await readout()
  check(detail.text.startsWith(day(data.days.at(-1))) && detail.contained, 'End/right-edge readout failed')
  await key('Escape')
  check(await readout() === null, 'Escape did not dismiss the chart readout')
  await hoverDay(data.days.length - 1, data.days.length)
  contents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
  await read(() => document.querySelector('.analytics-chart svg')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerType: 'mouse' })))
  await frame()
  check(await readout() === null, 'Pointer leave did not dismiss the chart readout')
  // 证据留在表格提示里，图上只给数值。
  const evidence = await read(() => [...document.querySelectorAll('.analytics-table.is-agents .is-strong')].map(node => node.title).join('; '))
  check(evidence.includes('Credits') && evidence.includes('已知下界'), 'Credit evidence left the table')
  await click('[aria-label="度量"] button', 'Token')
  check(await read(() => document.querySelector('.analytics-chart svg').getAttribute('aria-label')) === '每日 Token', 'Native metric switch missed')
  await click('[aria-label="时间范围"] button', '90 天')
  check(await read(() => document.querySelector('#fixture-status').dataset.range) === '90', 'Native range switch missed')
  const long = await query(90)
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(long) + ')')
  await frame()
  await hoverDay(long.days.length - 1, long.days.length)
  await click('[aria-label="时间范围"] button', '7 天')
  await contents.executeJavaScript('window.setCreditsFixture(' + JSON.stringify(data) + ')')
  await frame()
  check(await read(() => document.querySelector('.analytics-tile.is-hero .analytics-tile-value').textContent) === '$1.41', 'Data refresh missed the hero tile')
  // 数据更新后重新读数，不保留上一个范围的悬停日。
  const reread = await readout()
  check(reread === null || long.days.length <= data.days.length || reread.contained, 'Shorter range kept a stale readout')
  const layouts = []
  for (const [width, theme] of [[1512, 'dark'], [1100, 'dark'], [620, 'dark'], [1512, 'light']]) {
    win.setContentSize(width, 1000)
    await read(theme => { document.documentElement.dataset.theme = theme; document.querySelector('.analytics-page').scrollTop = 0 }, theme)
    contents.invalidate()
    await frame()
    const layout = await read(() => {
      const luminance = color => {
        const channels = color.match(/\d+/g).slice(0, 3).map(value => {
          const channel = Number(value) / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const page = document.querySelector('.analytics-page')
      const tiles = document.querySelector('.analytics-tiles')
      const chart = document.querySelector('.analytics-chart')
      const table = document.querySelector('.analytics-table.is-agents')
      const background = getComputedStyle(page).backgroundColor
      const textLuminance = luminance(getComputedStyle(document.querySelector('.analytics-tile-label')).color)
      const backgroundLuminance = luminance(background)
      return {
        width: innerWidth, background,
        labelContrast: (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05),
        noOverflow: page.scrollWidth <= innerWidth,
        tilesPerRow: getComputedStyle(tiles).gridTemplateColumns.split(' ').length,
        chartBeforeTable: chart.getBoundingClientRect().bottom <= table.getBoundingClientRect().top,
        smooth: [...document.querySelectorAll('.analytics-line')].every(path => path.getAttribute('d').includes(' C ')),
        visibleSeries: [...document.querySelectorAll('.analytics-line')].every(path => getComputedStyle(path).stroke !== 'none'),
        areaFilled: [...document.querySelectorAll('.analytics-area')].every(path => Number(getComputedStyle(path).fillOpacity) > 0.05)
      }
    })
    check(layout.background === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(28, 28, 28)'), 'Theme was not applied: ' + JSON.stringify(layout))
    check(layout.labelContrast >= 4.5, 'Secondary labels fail normal-text contrast: ' + JSON.stringify(layout))
    check(layout.noOverflow && layout.smooth && layout.visibleSeries && layout.areaFilled, 'Layout/curve regression: ' + JSON.stringify(layout))
    check(layout.chartBeforeTable, 'Chart/table order differs from design')
    check(width > 900 ? layout.tilesPerRow === 4 : layout.tilesPerRow <= 2, 'Tiles did not reflow: ' + JSON.stringify(layout))
    if (screenshotDir) {
      const image = await contents.capturePage({ x: 0, y: 0, width, height: 1000 }, { stayHidden: true, stayAwake: true })
      require('node:fs').writeFileSync(require('node:path').join(screenshotDir, `usage-${width}-${theme}.png`), image.toPNG())
    }
    layouts.push({ width, theme, ...layout })
  }
  return { nativePointer: true, nativeKeyboard: true, nativeControls: true, zeroVsMissing: true, shorterRange: true, layouts }
}
