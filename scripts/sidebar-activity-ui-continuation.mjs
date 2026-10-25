export async function exerciseSidebarActivityContinuation({ contents, screenshotPrefix, read, wait, point, click, check, row, group, layoutAnimations, titleAnimations, projectTypography }) {
  // The activity view owes the list one peak: live rows stay the brightest, running work
  // keeps a mark in the same right column as attention and completed rows, and the
  // finished tail runs denser than the work still in flight.
  const hierarchy = await read(`(() => {
    const live = document.querySelector('[data-activity-group="working"] .sb-sess')
    const done = document.querySelector('[data-activity-group="completed"] .sb-sess')
    const center = node => { const box = node.getBoundingClientRect(); return Math.round(innerWidth - (box.x + box.width / 2)) }
    const luminance = node => {
      const style = getComputedStyle(node)
      const paint = style.webkitTextFillColor === 'rgba(0, 0, 0, 0)' ? style.backgroundColor : style.color
      const [r, g, b] = paint.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number)
      const channel = value => value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    return {
      ringColumn: center(live.querySelector('.sb-running')),
      markColumn: center(done.closest('[data-activity-group]').querySelector('.sb-activity-status')),
      liveHeight: live.getBoundingClientRect().height,
      doneHeight: done.getBoundingClientRect().height,
      liveTitle: luminance(live.querySelector('.sb-sesstext')),
      doneTitle: luminance(done.querySelector('.sb-sesstext'))
    }
  })()`)
  check(Math.abs(hierarchy.ringColumn - hierarchy.markColumn) <= 2, `Running mark left the state column: ${JSON.stringify(hierarchy)}`)
  check(hierarchy.liveHeight > hierarchy.doneHeight, `Finished rows run as tall as live rows: ${JSON.stringify(hierarchy)}`)
  check(hierarchy.liveTitle > hierarchy.doneTitle + 0.1, `Live titles are not the peak of the list: ${JSON.stringify(hierarchy)}`)
  check(await read(`!document.querySelector('.sb-activity').textContent.includes('未核实的历史')`), 'Unknown history leaked into completed')
  await read(`window.activityRow = document.querySelector(${JSON.stringify(row)}); window.activityHeading = document.getElementById('sidebar-activity-working'); window.activityFixture.setReversed(true)`)
  await wait(`document.querySelector('[data-activity-group="working"] .sb-sess') === window.activityRow`)
  check(await read(`window.activityRow.closest('[data-motion-key]').getAnimations().length > 0`), 'Catalog reorder did not animate')
  await wait(`${layoutAnimations}.length === 0`)
  await read('window.activityFixture.setReversed(false)')
  await wait(`document.querySelector('[data-activity-group="working"] .sb-sess') !== window.activityRow && ${layoutAnimations}.length === 0`)
  await read("window.activityFixture.setPhase('attention')")
  await wait(`${group} === 'attention'`)
  check(await read(`window.activityRow === document.querySelector(${JSON.stringify(row)}) && document.activeElement === window.activityRow`), 'Cross-group move remounted the focused row')
  check(await read(`${titleAnimations}.length === 0 && getComputedStyle(window.activityRow.querySelector('.sb-sesstext')).webkitTextFillColor !== 'rgba(0, 0, 0, 0)'`), 'Attention title kept its working sweep or became invisible')
  const movement = await read(`${layoutAnimations}.map(animation => animation.effect.getKeyframes()[0].transform)`)
  check(movement.some(transform => transform && transform !== 'translateY(0px)'), 'State transition has no real layout animation')
  check(await read(`document.getElementById('sidebar-activity-working') === window.activityHeading && window.activityHeading.getAnimations().some(animation => animation.effect.getKeyframes()[0].transform !== 'translateY(0px)')`), 'Section heading did not move with its tasks')
  await wait(`${layoutAnimations}.length === 0`)
  await click('main h1')
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = '${theme}'`)
    check(await read(`getComputedStyle(document.querySelector('.sidebar')).backgroundColor === '${theme === 'light' ? 'rgb(247, 247, 245)' : 'rgb(24, 24, 24)'}'`), 'Theme did not update the sidebar surface')
    await wait(`document.querySelector('.sidebar').getAnimations({ subtree: true }).every(animation => animation.effect.getComputedTiming().endTime === Infinity)`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    check(await read(`getComputedStyle(window.activityRow.querySelector('.sb-sesstext')).fontSize === ${JSON.stringify(projectTypography.size)} && getComputedStyle(window.activityRow).backgroundImage === 'none' && getComputedStyle(window.activityRow).boxShadow === 'none'`), 'Production CSS overrode the flat-row appearance or shared typography')
    if (screenshotPrefix) require('node:fs').writeFileSync(`${screenshotPrefix}-${theme}.png`, (await contents.capturePage({ x: 0, y: 0, width: 280, height: 650 })).toPNG())
  }
  // Put the existing completed task before this task in catalog order. Promotion
  // must override that order, both on completion and on a later metadata refresh.
  await read('window.activityFixture.setReversed(true)')
  await wait(`${layoutAnimations}.length === 0`)
  // Change state between native press and release: the clicked row must not relocate.
  const position = await point(row)
  await read(`window.activityPointerDown = false; window.activityRow.addEventListener('pointerdown', () => { window.activityPointerDown = true }, { once: true })`)
  contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
  await wait(`window.activityPointerDown && document.activeElement === window.activityRow`)
  await read(`window.activityFixture.setPhase('completed')`)
  check(await read(`${group} === 'attention'`), 'Pointer-held row moved before click completed')
  contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
  await wait(`${group} === 'completed' && document.querySelector('#activity-selection').textContent === 'webhook'`)
  check(await read(`!document.getElementById('sidebar-activity-attention') && document.getElementById('sidebar-activity-completed').textContent === '已完成'`), 'Empty section did not disappear after explicit completion')
  await wait(`${layoutAnimations}.length === 0`)
  check(await read(`document.querySelector('[data-activity-group="completed"] .sb-sess') === window.activityRow`), 'New completion did not move ahead of an existing completed task')
  await click('[aria-label="置顶会话：Retry failed webhook delivery"]')
  await wait(`document.querySelector('#activity-pinned').textContent === 'true'`)
  check(await read(`document.querySelector('[data-activity-group="completed"] .sb-sess') === window.activityRow`), 'New completion was not first, or metadata refresh lost its position')

  await contents.debugger.attach('1.3')
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await wait(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
    await read(`window.activityFixture.setPhase('working')`)
    await wait(`${group} === 'working'`)
    const reducedState = await read(`(() => {
      const title = window.activityRow.querySelector('.sb-sesstext')
      getComputedStyle(title).backgroundColor
      title.style.backgroundColor = 'rgb(20, 40, 60)'
      getComputedStyle(title).backgroundColor
      const result = { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, layout: ${layoutAnimations}.length,
        title: ${titleAnimations}.map(animation => ({ name: animation.animationName, property: animation.transitionProperty })),
        colorAnimations: title.getAnimations().length, fill: getComputedStyle(title).webkitTextFillColor }
      title.style.backgroundColor = ''
      return result
    })()`)
    check(reducedState.reduced && reducedState.layout === 0 && reducedState.title.length === 0 && reducedState.colorAnimations === 0 && reducedState.fill !== 'rgba(0, 0, 0, 0)', `Reduced-motion moves/hides the title or adds an undeclared transition: ${JSON.stringify(reducedState)}`)
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'forced-colors', value: 'active' }] })
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await wait(`matchMedia('(forced-colors: active)').matches`)
    check(await read(`${titleAnimations}.length === 0 && getComputedStyle(window.activityRow.querySelector('.sb-sesstext')).webkitTextFillColor !== 'rgba(0, 0, 0, 0)'`), 'Forced colors hides or animates the working title')
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await wait(`!matchMedia('(forced-colors: active)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches`)
  } finally { contents.debugger.detach() }
  check(await read(`window.activityRow === document.querySelector(${JSON.stringify(row)})`), 'Reduced-motion state change remounted the row')
  await wait(`${layoutAnimations}.length === 0`)
  for (const phase of ['unknown', 'failed']) {
    await read(`window.activityFixture.setPhase('${phase}')`)
    await wait(`!document.querySelector(${JSON.stringify(row)})`)
    check(await read(`!document.querySelector('.sb-activity').textContent.includes('Retry failed webhook delivery')`), 'Non-success terminal evidence appeared completed')
  }
  await read("window.activityFixture.setPhase('working')")
  await wait(`${group} === 'working' && ${layoutAnimations}.length === 0`)
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = '${theme}'`)
    await wait(`${titleAnimations}.some(animation => animation.animationName === 'sb-activity-sweep') && getComputedStyle(document.querySelector('.sidebar')).backgroundColor === '${theme === 'light' ? 'rgb(247, 247, 245)' : 'rgb(24, 24, 24)'}'`)
    await wait(`document.querySelector('.sidebar').getAnimations({ subtree: true }).every(animation => animation.effect.getComputedTiming().endTime === Infinity)`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (screenshotPrefix) require('node:fs').writeFileSync(`${screenshotPrefix}-working-${theme}.png`, (await contents.capturePage({ x: 0, y: 0, width: 280, height: 650 })).toPNG())
  }
  await click('#activity-sidebar-view-projects')
  await wait(`document.querySelector('.sb-list').textContent.includes('未核实的历史')`)
  await click('#activity-sidebar-view-activity')
  await wait(`${group} === 'working'`)
  // Forty completed rows must not disable the existing cross-group FLIP.
  await read("window.activityFixture.setPhase('completed'); window.activityFixture.setBulk(true)")
  await wait(`document.querySelectorAll('.sb-activity-item[data-activity-group="completed"]').length === 40 && ${group} === 'completed' && ${layoutAnimations}.length === 0`)
  check(await read("document.querySelectorAll('.sb-activity-item').length === 41"), 'Large activity baseline changed its presentation limit')
  await read(`window.largeActivityRow = document.querySelector(${JSON.stringify(row)}).closest('[data-motion-key]'); window.activityFixture.setPhase('working')`)
  await wait(`${group} === 'working'`)
  check(await read(`document.querySelector(${JSON.stringify(row)}).closest('[data-motion-key]') === window.largeActivityRow && window.largeActivityRow.getAnimations().some(animation => animation.id === 'scry-list-reorder' && animation.effect.getTiming().duration === 300 && animation.effect.getKeyframes().some(frame => frame.transform && new DOMMatrixReadOnly(frame.transform).m42 !== 0))`), 'Large activity survivor did not retain its 300ms transform')
  await wait(`${layoutAnimations}.length === 0`)
  await read('window.activityFixture.setBulk(false)')
  await wait(`${layoutAnimations}.length === 0`)
  await click(row)
  await wait(`document.activeElement === document.querySelector(${JSON.stringify(row)})`)
  await click('[aria-label="存档会话：Retry failed webhook delivery"]')
  await wait(`!document.querySelector(${JSON.stringify(row)})`)
  await read('window.activityFixture.setBulk(true)')
  await wait(`document.querySelector('.sb-activity-limit')?.textContent.includes('31')`)
  check(await read(`document.querySelectorAll('.sb-activity-item').length === 41`), 'History DOM is not bounded')
  await click('.sb-search input')
  await wait(`document.activeElement === document.querySelector('.sb-search input')`)
  await contents.insertText('历史记录 69')
  await wait(`document.querySelectorAll('.sb-activity-item').length === 1 && document.querySelector('.sb-activity').textContent.includes('历史记录 69')`)
  await contents.insertText('不存在')
  await wait(`document.querySelector('.sb-activity .sb-empty') != null`)
  await click('#activity-sidebar-view-projects')
  await wait(`!document.querySelector('.sb-activity') && document.querySelector('.sb-project-section') != null`)
  await read('window.activityFixture.unmount()')
  await wait(`!document.querySelector('.sidebar')`)
  return { tabsKeyboard: true, nativeSelection: true, crossGroupIdentityAndFocus: true, animatedLayout: true,
    conditionalSections: true, movingHeadings: true, flatAppearance: true, honestCompletion: true, inGroupReorder: true,
    stateColumn: true, livePeak: true,
    pointerHeldTarget: true, pinAndArchive: true, reducedMotion: true, largeActivitySurvivor300: true, boundedHistory: true, searchAndEmpty: true, originalView: true, unmount: true,
    sharedTypography: true, workingSweep: true, longTitleSweepContrast: true, staticTerminalTitles: true, forcedColors: true }
}
