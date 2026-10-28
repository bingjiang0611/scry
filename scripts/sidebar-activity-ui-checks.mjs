import { exerciseSidebarActivityContinuation } from './sidebar-activity-ui-continuation.mjs'
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
  const projectTypography = await read(`(() => {
    const style = getComputedStyle(document.querySelector('.sb-sess .sb-sesstext'));
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  })()`)
  await click('#activity-sidebar-view-projects')
  await wait(`document.activeElement?.id === 'activity-sidebar-view-projects'`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await wait(`document.activeElement?.id === 'activity-sidebar-view-activity' && ${group} === 'working'`)
  const activityTypography = await read(`(() => {
    const style = getComputedStyle(document.querySelector(${JSON.stringify(row)}).querySelector('.sb-sesstext'));
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  })()`)
  check(JSON.stringify(activityTypography) === JSON.stringify(projectTypography), 'Activity titles do not match project-list typography')
  const titleAnimations = `document.querySelector(${JSON.stringify(row)}).querySelector('.sb-sesstext').getAnimations()`
  check(await read(`${titleAnimations}.some(animation => animation.animationName === 'sb-activity-sweep')`), 'Working title has no sweep animation')
  const sweep = await read(`(async () => {
    const title = document.querySelector(${JSON.stringify(row)}).querySelector('.sb-sesstext');
    const animation = title.getAnimations().find(item => item.animationName === 'sb-activity-sweep');
    await animation.ready;
    const before = getComputedStyle(title).backgroundPositionX;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, after: getComputedStyle(title).backgroundPositionX, frames: animation.effect.getKeyframes() };
  })()`)
  check(sweep.before !== sweep.after && sweep.frames[0].backgroundPositionX === '-96px' && sweep.frames.at(-1).backgroundPositionX === 'calc(100% + 96px)', 'Working sweep is not advancing from left to right')
  check(await read(`Array.from(document.querySelectorAll('[data-activity-group="completed"] .sb-sesstext')).every(title => title.getAnimations().length === 0 && getComputedStyle(title).webkitTextFillColor !== 'rgba(0, 0, 0, 0)')`), 'Completed titles inherited the working sweep')
  await click(row)
  await wait(`document.querySelector('#activity-selection').textContent === 'webhook' && document.activeElement === document.querySelector(${JSON.stringify(row)})`)
  check(await read(`document.querySelector('#activity-selection-cwd').textContent === '/fixture/storefront-worktree' && document.querySelector(${JSON.stringify(row)}).getAttribute('aria-current') === 'true'`), 'Activity click must select the session worktree, not its project root')
  await read('window.activityFixture.setLongTitle(true)')
  await wait(`document.querySelector(${JSON.stringify(row)}).textContent.includes('/design-loop ios')`)
  check(await read(`(() => { const title = document.querySelector(${JSON.stringify(row)}).querySelector('.sb-sesstext'); return title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis'; })()`), 'Long running title does not truncate')
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = '${theme}'`)
    await wait(`document.querySelector('.sidebar').getAnimations({ subtree: true }).every(animation => animation.effect.getComputedTiming().endTime === Infinity)`)
    const sweepImages = []
    for (const time of [1100, 2100]) {
      const rect = await read(`(async () => {
        const title = document.querySelector(${JSON.stringify(row)}).querySelector('.sb-sesstext');
        const animation = title.getAnimations().find(item => item.animationName === 'sb-activity-sweep');
        animation.pause();
        await animation.ready;
        animation.currentTime = ${time};
        const bounds = title.getBoundingClientRect();
        return { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
      })()`)
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const image = await contents.capturePage(rect)
      sweepImages.push(image.toBitmap())
      if (screenshotPrefix) require('node:fs').writeFileSync(`${screenshotPrefix}-sweep-${theme}-${time}.png`, image.toPNG())
    }
    // A different PNG alone accepted an imperceptible shimmer. Require a visible
    // channel change on multiple glyph pixels, not just a single changed byte.
    let visiblePixels = 0
    for (let index = 0; index < sweepImages[0].length; index += 4) {
      const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(sweepImages[0][index + channel] - sweepImages[1][index + channel])))
      if (delta >= 40) visiblePixels++
    }
    check(visiblePixels >= 20, `Long ${theme} working title sweep is too faint: ${visiblePixels} pixels changed by >=40/255`)
  }
  await read(`${titleAnimations}.find(animation => animation.animationName === 'sb-activity-sweep').play(); window.activityFixture.setLongTitle(false); document.documentElement.dataset.theme = 'dark'`)
  await wait(`document.querySelector(${JSON.stringify(row)}).textContent.includes('Retry failed webhook delivery')`)
  check(await read(`document.querySelectorAll('.sb-activity-heading').length === 2 && !document.querySelector('.sb-activity-project') && !document.querySelector('.sb-activity-heading span')`), 'Empty groups, project subtitles or counts leaked into the flat list')
  return exerciseSidebarActivityContinuation({ contents, screenshotPrefix, read, wait, point, click, check, row, group, layoutAnimations, titleAnimations, projectTypography })
}
