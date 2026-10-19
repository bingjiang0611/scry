// Isolated Electron fixture; real React, CSS, Web Animations and native input events.
export async function exerciseSidebarActivity(contents, screenshotPrefix) {
  const check = (value, message) => { if (!value) throw new Error(`Sidebar activity: ${message}`) }
  const read = expression => contents.executeJavaScript(expression)
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    const state = await read(`({ focused: document.activeElement?.outerHTML.slice(0, 240), query: document.querySelector('.sb-search input')?.value })`)
    throw new Error(`Sidebar activity condition timed out: ${expression}; state=${JSON.stringify(state)}`)
  }
  const point = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    return read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Obscured target: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
  }
  const click = async selector => {
    const position = await point(selector)
    contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
  }
  const row = `.sb-activity [data-provider="pi"]`
  const group = `document.querySelector(${JSON.stringify(row)})?.closest('[data-activity-group]')?.dataset.activityGroup`
  const layoutAnimations = `document.querySelector('.sb-activity').getAnimations({ subtree: true }).filter(animation => animation.effect.target.hasAttribute('data-motion-key'))`
  await wait('window.activityFixture && document.querySelector("[role=tab]")')
  check(await read(`document.querySelector('[role="tab"][aria-selected="true"]').textContent === '项目'`), 'Original project view is not the default')
  await click('#activity-sidebar-view-projects')
  await wait(`document.activeElement?.id === 'activity-sidebar-view-projects'`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await wait(`document.activeElement?.id === 'activity-sidebar-view-activity' && ${group} === 'working'`)
  await click(row)
  await wait(`document.querySelector('#activity-selection').textContent === 'webhook' && document.activeElement === document.querySelector(${JSON.stringify(row)})`)
  check(await read(`document.querySelectorAll('.sb-activity-heading').length === 2 && !document.querySelector('.sb-activity-project') && !document.querySelector('.sb-activity-heading span')`), 'Empty groups, project subtitles or counts leaked into the flat list')
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
    check(await read(`getComputedStyle(window.activityRow).fontSize === '15px' && getComputedStyle(window.activityRow).backgroundImage === 'none' && getComputedStyle(window.activityRow).boxShadow === 'none'`), 'Production CSS overrode the approved flat-row appearance')
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
    await read(`window.activityFixture.setPhase('working')`)
    await wait(`${group} === 'working'`)
    check(await read(`${layoutAnimations}.length === 0`), 'Reduced-motion still animates')
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
  await click('#activity-sidebar-view-projects')
  await wait(`document.querySelector('.sb-list').textContent.includes('未核实的历史')`)
  await click('#activity-sidebar-view-activity')
  await wait(`${group} === 'working'`)
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
    pointerHeldTarget: true, pinAndArchive: true, reducedMotion: true, boundedHistory: true, searchAndEmpty: true, originalView: true, unmount: true }
}
