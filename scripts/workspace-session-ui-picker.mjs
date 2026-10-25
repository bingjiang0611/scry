import assert from 'node:assert/strict'

export async function assertPickerAnchored(evaluate) {
  const geometry = await evaluate(`(() => {
    const picker = document.querySelector('.workspace-picker').getBoundingClientRect()
    const anchor = document.querySelector('[data-workspace-menu][aria-expanded="true"]').getBoundingClientRect()
    const shell = document.querySelector('.composer-shell').getBoundingClientRect()
    const strip = document.querySelector('.workspace-context-strip').getBoundingClientRect()
    return { top: picker.top, bottom: picker.bottom, width: picker.width, left: picker.left, right: picker.right,
      anchorTop: anchor.top, viewport: innerWidth, stripHeight: strip.height, shellBottom: shell.bottom, stripTop: strip.top,
      modal: Boolean(document.querySelector('.workspace-picker[aria-modal="true"], .workspace-apply, .workspace-picker-layer')),
      extraCopy: document.querySelectorAll('.workspace-composer-context > p, .workspace-context-recovery').length }
  })()`)
  // T3-style popovers attach to the new bottom strip, not to the send button above it.
  assert.ok(geometry.top >= 0 && Math.abs(geometry.bottom - geometry.anchorTop + 6) < 2 && geometry.width <= 320, JSON.stringify(geometry))
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport)
  assert.ok(geometry.stripHeight <= 32 && geometry.stripTop >= geometry.shellBottom)
  assert.equal(geometry.modal, false)
  assert.equal(geometry.extraCopy, 0, 'ordinary selection is a compact strip, not a preparation dashboard')
}

export async function assertCompactMenus({ cdp, evaluate, click, key, wait, screenshot, newDraft, cwd, openPicker }) {
  await click('[data-workspace-menu="refs"]')
  await wait(() => evaluate(`!document.querySelector('.workspace-picker')`), 'trigger toggles its menu closed')
  await click('[data-workspace-menu="workspace"]')
  await wait(() => evaluate(`document.querySelectorAll('.workspace-mode-choice')[1]?.disabled === false`), 'workspace menu ready')
  await assertPickerAnchored(evaluate)
  assert.ok(await evaluate(`document.querySelectorAll('.workspace-mode-choice')[1].title.includes('不复制当前工作区未提交的文件')`))
  assert.equal(await evaluate(`document.querySelector('.main-area')?.inert`), false, 'popover does not inert the conversation')
  await key('Escape', 'Escape', 27)
  assert.equal(await evaluate(`document.activeElement?.dataset.workspaceMenu`), 'workspace')
  await openPicker()
  await click('textarea')
  await wait(() => evaluate(`!document.querySelector('.workspace-picker') && document.activeElement?.tagName === 'TEXTAREA'`), 'outside click dismisses without stealing focus')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 900, deviceScaleFactor: 1, mobile: false })
  await openPicker()
  await screenshot('picker-narrow')
  await key('Escape', 'Escape', 27)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  for (const theme of ['light', 'dark']) {
    await evaluate(`localStorage.setItem('scry.theme', ${JSON.stringify(theme)})`)
    await cdp.send('Page.reload')
    await wait(() => evaluate(`document.documentElement?.dataset.theme === ${JSON.stringify(theme)} && Boolean(document.querySelector('.workspace-context-strip'))`), `${theme} picker preference after reload`)
    await newDraft(cwd)
    await openPicker()
    await screenshot(`picker-${theme}-compact`)
    if (theme === 'light') await key('Escape', 'Escape', 27)
  }
}

export async function assertPendingDraft(cdp, prompt) {
  // Inspect before Debugger.pause: this fixture's DOM evaluation stalls once paused.
  const response = await cdp.send('Runtime.evaluate', { expression: `({ input: document.querySelector('textarea')?.value,
    disabled: document.querySelector('.send')?.disabled })`, awaitPromise: false, returnByValue: true })
  assert.equal(response.exceptionDetails, undefined)
  const pending = response.result.value
  assert.equal(pending.input, prompt, 'preparation retains the real composer draft until ACK')
  assert.equal(pending.disabled, true, 'preparation blocks duplicate sends')
}

export async function assertNewWorktreeDefaults(evaluate) {
  const state = await evaluate(`({ title: document.querySelector('[data-workspace-menu="workspace"]')?.title,
    mode: document.querySelector('[data-workspace-menu="workspace"]')?.textContent,
    form: Boolean(document.querySelector('.workspace-new-branch, .workspace-apply')) })`)
  assert.equal(state.form, false)
  assert.ok(state.mode.includes('新建 worktree'))
  const name = state.title.match(/scry\/[a-f0-9]{8}/)?.[0]
  assert.match(name, /^scry\/[a-f0-9]{8}$/)
  return name
}
