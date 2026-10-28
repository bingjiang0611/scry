import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function contrast(foreground, background) {
  const parse = color => {
    assert.match(color, /^rgba?\(/)
    const channels = color.match(/[\d.]+/g).map(Number)
    assert.ok(channels.length === 3 || channels[3] === 1, `Expected an opaque computed color: ${color}`)
    return channels.slice(0, 3).map(value => value / 255)
  }
  const luminance = color => parse(color).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const first = luminance(foreground), second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

export async function exerciseFrameInspection({ workflow, evaluate, wait, click, cdp, recordPath, workflowId, attempt, evidence }) {
  assert.equal(typeof attempt.frameId, 'string', 'The actual admission must expose its canonical frame')
  const frameId = attempt.frameId
  const canonical = await workflow('inspectFrame', workflowId, frameId)
  assert.equal(canonical.state, 'available')
  assert.equal(canonical.frame.frameId, frameId)
  assert.equal(canonical.frame.nodeId, attempt.nodeId)
  assert.equal(canonical.frame.parentage.state, 'available')
  for (const field of ['callInputRef', 'prompt', 'output', 'bindings', 'resultRef', 'scopePath']) assert.equal(Object.hasOwn(canonical.frame, field), false, field)
  const parent = await workflow('inspectFrame', workflowId, canonical.frame.parentage.frameId)
  assert.equal(parent.state, 'available')
  assert.equal(parent.frame.nodeId, 'siblings')
  const before = JSON.parse(await readFile(recordPath, 'utf8'))
  const open = `[data-workflow-id="${workflowId}"] [data-workflow-frame-open="${frameId}"]`
  const visibleFrame = id => evaluate(`document.querySelector('.workflow-frame-inspector [data-workflow-frame]')?.getAttribute('data-workflow-frame') === ${JSON.stringify(id)}`)
  await click(open)
  await wait(() => visibleFrame(frameId), 'actual canonical frame inspector')
  assert.equal(await evaluate(`document.querySelector('.workflow-frame-inspector')?.contains(document.activeElement)`), true)
  const key = async (name, code, value, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: value, modifiers })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: value, modifiers })
  }
  await key('Tab', 'Tab', 9, 8)
  assert.equal(await evaluate(`document.activeElement?.getAttribute('data-workflow-frame-action')`), 'refresh', 'Shift+Tab must stay inside the dialog')
  await key('Tab', 'Tab', 9)
  assert.equal(await evaluate(`document.activeElement?.getAttribute('data-workflow-frame-action')`), 'close', 'Tab must wrap to the first control')
  await click(`[data-workflow-frame-link="${parent.frame.frameId}"]`)
  await wait(() => visibleFrame(parent.frame.frameId), 'canonical structural parent navigation')
  assert.equal(await evaluate(`document.activeElement?.tagName`), 'H2', 'Navigation must not drop focus into the running workflow')
  await click('[data-workflow-frame-action="back"]')
  await wait(() => visibleFrame(frameId), 'canonical frame back navigation')
  const firstRead = await evaluate(`document.querySelector('.workflow-frame-inspector time')?.dateTime`)
  await click('[data-workflow-frame-action="refresh"]')
  await wait(async () => await visibleFrame(frameId) && await evaluate(`document.querySelector('.workflow-frame-inspector time')?.dateTime > ${JSON.stringify(firstRead)}`), 'explicit frame refresh')
  const refreshedFocus = await evaluate(`({ tag: document.activeElement?.tagName,
    action: document.activeElement?.getAttribute('data-workflow-frame-action'),
    inside: Boolean(document.activeElement?.closest('.workflow-frame-inspector')) })`)
  await writeFile(join(evidence, 'frame-refresh-focus.json'), JSON.stringify(refreshedFocus, null, 2))
  assert.equal(refreshedFocus.inside, true, 'Refresh must retain focus before disabling its own button')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 800, deviceScaleFactor: 1, mobile: false })
  let layout
  try {
    layout = await evaluate(`(() => {
      const dialog = document.querySelector('.workflow-frame-inspector'), box = dialog.getBoundingClientRect()
      const samples = ['h2', '.workflow-frame-phase', 'dt', 'dd code'].map(selector => {
        const element = dialog.querySelector(selector), style = getComputedStyle(element)
        return { selector, color: style.color, background: getComputedStyle(dialog).backgroundColor, fontSize: style.fontSize }
      })
      return { left: box.left, right: box.right, viewport: innerWidth, client: dialog.clientWidth, scroll: dialog.scrollWidth, samples,
        fieldsFit: [...dialog.querySelectorAll('dd')].every(field => field.scrollWidth <= field.clientWidth + 1) }
    })()`)
    assert.ok(layout.left >= 8 && layout.right <= layout.viewport - 8, JSON.stringify(layout))
    assert.ok(layout.scroll <= layout.client + 1 && layout.fieldsFit, JSON.stringify(layout))
    for (const sample of layout.samples) {
      sample.contrast = contrast(sample.color, sample.background)
      assert.ok(sample.contrast >= 4.5, JSON.stringify(sample))
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(evidence, 'frame-inspector-430.png'), Buffer.from(shot.data, 'base64'))
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride')
  }
  await key('Escape', 'Escape', 27)
  await wait(() => evaluate(`!document.querySelector('.workflow-frame-inspector')`), 'inspector Escape close')
  assert.equal(await evaluate(`document.activeElement?.getAttribute('data-workflow-frame-open')`), frameId, 'Close must restore the originating row button')
  const after = JSON.parse(await readFile(recordPath, 'utf8'))
  for (const field of ['intents', 'outcomes', 'systemIntents', 'systemOutcomes', 'stopRequests', 'execution', 'preview']) assert.deepEqual(after[field], before[field], `Inspection changed ${field}`)
  assert.equal(after.progress.dispatchAttempts, before.progress.dispatchAttempts)
  await writeFile(join(evidence, 'frame-inspection.json'), JSON.stringify({ canonical, parent, layout, ledgerUnchanged: true, focusRestored: true }, null, 2))
  return { frameId, parentFrameId: parent.frame.frameId, ledgerUnchanged: true, focusRestored: true }
}
