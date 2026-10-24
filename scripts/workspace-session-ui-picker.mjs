import assert from 'node:assert/strict'

export async function assertPickerAboveSend(evaluate) {
  const geometry = await evaluate(`(() => {
    const picker = document.querySelector('.workspace-picker').getBoundingClientRect()
    const send = document.querySelector('.send').getBoundingClientRect()
    return { top: picker.top, bottom: picker.bottom, width: picker.width, sendTop: send.top }
  })()`)
  assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.sendTop && geometry.width <= 600, JSON.stringify(geometry))
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
  const state = await evaluate(`({ name: document.querySelector('.workspace-new-branch input')?.value,
    explanation: document.querySelector('.workspace-picker')?.textContent })`)
  assert.match(state.name, /^scry\/[a-f0-9]{8}$/)
  assert.ok(state.explanation.includes('不复制当前工作区未提交的文件'))
}
