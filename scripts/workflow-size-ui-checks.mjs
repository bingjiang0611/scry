import assert from 'node:assert/strict'

/** Injected config/provenance fixture only; real FileStore checks are separate. */
export async function checkWorkflowSizePreference({ read, wait, click, win }) {
  const selector = '[data-workflow-size=preference]'
  const refresh = '[data-workflow-size=refresh]'
  assert.equal(await read(`document.querySelector('${selector}').value`), 'default', 'default must not pretend that the user selected medium')
  await read(`document.querySelector('${selector}').focus()`)
  for (const [value, character] of [['unrestricted', '不'], ['small', '小']]) {
    if (value === 'small') {
      // A fresh settings view must restore the previous selection without planning.
      await read(`window.workflowFixture.sizeSelectBeforeRehydrate = document.querySelector('${selector}'); window.workflowFixture.rehydrate()`)
      // The old dialog already satisfies the value/readiness condition. Wait for
      // the replacement control, otherwise native input can target a retiring node.
      await wait(`!window.workflowFixture.sizeSelectBeforeRehydrate.isConnected && document.querySelector('${selector}')?.value === 'unrestricted' && !document.querySelector('[data-workflow-action=plan]').disabled`)
    }
    await read(`document.querySelector('${selector}').focus()`)
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: character })
    await wait(`document.querySelector('${selector}').value === '${value}' && document.querySelector('${selector}').getAttribute('aria-disabled') === 'false'`)
    assert.equal(await read(`document.activeElement === document.querySelector('${selector}')`), true, 'persisting a preference retains native select focus')
  }
  assert.equal(await read('window.workflowFixture.counters.plans'), 0, 'settings do not initiate planning')
  await read('window.workflowFixture.installSizeFileOverride()')
  await click(refresh)
  await wait(`!document.querySelector('${selector}') && document.querySelector('.workflow-size-setting').textContent.includes('settings.json')`)
  assert.equal(await read("document.querySelector('.workflow-size-setting').textContent.includes('大：少于 50 个 Agent')"), true)
  assert.equal(await read(`document.activeElement === document.querySelector('${refresh}')`), true, 'refresh does not disable its focused button')
  await read('window.workflowFixture.restoreSizePreference()')
  await click(refresh)
  await wait(`document.querySelector('${selector}')?.value === 'small' && document.querySelector('${selector}').getAttribute('aria-disabled') === 'false'`)
  assert.equal(await read('window.workflowFixture.counters.plans'), 0)
  return { defaultDistinct: true, nativeSelection: true, fileOverrideReadOnly: true, focusRetained: true }
}
