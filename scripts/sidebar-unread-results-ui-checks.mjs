// Real Sidebar and native input, with the same unread snapshot used by the App.
export async function exerciseSidebarUnreadResults(contents) {
  const read = expression => contents.executeJavaScript(expression)
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    throw new Error(`Sidebar unread results condition timed out: ${expression}`)
  }
  const click = async selector => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest' });
      const rect = node.getBoundingClientRect();
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Obscured target: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const row = '.sb-activity [data-provider="pi"]'
  const group = `document.querySelector(${JSON.stringify(row)})?.closest('[data-activity-group]')?.dataset.activityGroup`
  const layoutIdle = `document.querySelector('.sb-activity').getAnimations({ subtree: true }).every(animation => !animation.effect.target.hasAttribute('data-motion-key'))`
  await wait('window.activityFixture && document.querySelector("[role=tab]")')
  for (const phase of ['unknown', 'failed', 'completed']) {
    await read(`window.activityFixture.setPhase('${phase}'); window.activityFixture.setUnread(true)`)
    await wait(`document.querySelector('.sb-sess[data-provider="pi"] .sb-unread') != null`)
    await click('#activity-sidebar-view-activity')
    const expected = phase === 'completed' ? 'completed' : 'updates'
    await wait(`${group} === '${expected}' && ${layoutIdle}`)
    if (expected === 'updates') {
      await wait(`document.querySelector('#sidebar-activity-updates')?.textContent === '待查看'`)
    }
    await click(row)
    if (phase === 'completed') {
      await wait(`${group} === 'completed' && !document.querySelector(${JSON.stringify(row)}).querySelector('.sb-unread')`)
    } else {
      await wait(`!document.querySelector(${JSON.stringify(row)}) && ${layoutIdle}`)
    }
    await click('#activity-sidebar-view-projects')
  }
  return { unknownAndFailedUnreadVisible: true, completedRemainsCompleted: true, readClearsUpdates: true, projectIndicatorParity: true }
}
