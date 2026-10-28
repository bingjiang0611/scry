import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Real main/preload/renderer/FileStore; no planning or Provider execution is requested.
export async function exerciseWorkflowSizePreferences({ workflow, evaluate, wait, click, cdp, userData, evidence, readInputs }) {
  const directory = join(userData, 'workflows')
  const preferences = join(directory, 'preferences.json')
  const settings = join(directory, 'settings.json')
  const recordHashes = async () => {
    const files = (await readdir(directory)).filter(name => name.startsWith('workflow-') && name.endsWith('.json')).sort()
    return Object.fromEntries(await Promise.all(files.map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])))
  }
  const beforeRecords = await recordHashes()
  const beforeInputs = (await readInputs()).length
  const initial = await workflow('sizeGuideline')
  assert.equal(initial.value, 'medium')
  assert.equal(initial.source, 'default')
  await click('.workflow-entry-actions button[title]')
  const selector = '[data-workflow-size=preference]'
  const refresh = '[data-workflow-size=refresh]'
  await wait(() => evaluate(`document.querySelector('${selector}')?.getAttribute('aria-disabled') === 'false'`), 'real size preference control')
  assert.equal(await evaluate(`document.querySelector('${selector}').value`), 'default')
  await evaluate(`(() => { const control = document.querySelector('${selector}'); control.addEventListener('change', event => { window.__sizePreferenceTrusted = event.isTrusted }, { once: true }); control.focus() })()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '小' })
  await wait(() => evaluate(`document.querySelector('${selector}').value === 'small' && document.querySelector('${selector}').getAttribute('aria-disabled') === 'false'`), 'native size preference persisted')
  assert.equal(await evaluate('window.__sizePreferenceTrusted'), true)
  const selected = await workflow('sizeGuideline')
  assert.equal(selected.value, 'small')
  assert.equal(selected.source, 'preference')
  const preferenceBytes = await readFile(preferences, 'utf8')
  assert.equal(JSON.parse(preferenceBytes).workflowSizeGuideline, 'small')
  await assert.rejects(() => workflow('setSizeGuideline', { value: 'large', path: '/outside' }))
  assert.equal(await readFile(preferences, 'utf8'), preferenceBytes)

  await writeFile(settings, JSON.stringify({ workflowSizeGuideline: 'large' }), { mode: 0o600 })
  await click(refresh)
  await wait(() => evaluate(`!document.querySelector('${selector}') && document.querySelector('.workflow-size-setting').textContent.includes('settings.json')`), 'real file override is read-only')
  assert.equal(await evaluate("document.querySelector('.workflow-size-setting').textContent.includes('大：少于 50 个 Agent')"), true)
  await assert.rejects(() => workflow('setSizeGuideline', null), /settings\.json/)
  assert.equal(await readFile(preferences, 'utf8'), preferenceBytes, 'file override cannot alter the saved preference')

  await writeFile(settings, 'null')
  await click(refresh)
  await wait(() => evaluate("Boolean(document.querySelector('.workflow-size-setting [role=alert]'))"), 'real malformed file error')
  assert.equal(await evaluate(`Boolean(document.querySelector('${selector}'))`), false)
  assert.equal(await evaluate('document.querySelector("[data-workflow-action=plan]").disabled'), true)
  await assert.rejects(() => workflow('sizeGuideline'))
  await rm(settings)
  await click(refresh)
  await wait(() => evaluate(`document.querySelector('${selector}')?.value === 'small' && document.querySelector('${selector}').getAttribute('aria-disabled') === 'false'`), 'prior preference restored after file removal')
  const restored = await workflow('sizeGuideline')
  assert.deepEqual(restored, selected)
  await click('.workflow-modal .workflow-actions button:first-child')
  await wait(() => evaluate('!document.querySelector(".workflow-modal")'), 'settings draft closed without planning')
  assert.equal((await readInputs()).length, beforeInputs, 'settings cannot dispatch a Provider')
  assert.deepEqual(await recordHashes(), beforeRecords, 'existing frozen records, outcomes and budgets remain byte-identical')
  const historicalRows = await evaluate('Array.from(document.querySelectorAll(".workflow-progress .workflow-size-recorded"), node => node.textContent)')
  assert.ok(historicalRows.length > 0)
  assert.ok(historicalRows.every(text => text.includes('未记录规模建议')), 'fixed templates cannot be relabelled with the current global preference')
  const result = { initial, selected, restored, trustedNativeSelection: true, malformedFileRejected: true,
    fileOverrideReadOnly: true, recordHashes: beforeRecords, offlineCallsBefore: beforeInputs, offlineCallsAfter: (await readInputs()).length }
  await writeFile(join(evidence, 'size-preferences.json'), JSON.stringify(result, null, 2))
  return result
}

export async function verifyWorkflowSizePreferencesCold(workflow, previous) {
  assert.deepEqual(await workflow('sizeGuideline'), previous.selected)
}
