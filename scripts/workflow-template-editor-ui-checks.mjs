import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { exerciseWorkflowRevisionEditor } from './workflow-revision-ui-checks.mjs'
import { exerciseCheckFixDraft } from './workflow-check-fix-ui-checks.mjs'

const json = JSON.stringify
const hash = text => createHash('sha256').update(text).digest('hex')
const wait = async (probe, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out: ' + label)
}
export async function exerciseWorkflowTemplateEditor(cdp, evaluate, fixture, screenshots, bootstrap = false) {
  const callsBefore = await readFile(fixture.inputsFile, 'utf8')
  const click = async selector => {
    try { await wait(() => evaluate(`Boolean(document.querySelector(${json(selector)}) && !document.querySelector(${json(selector)}).disabled)`), 'enabled ' + selector) }
    catch (error) {
      console.error('Template target diagnostic', await evaluate(`JSON.stringify({selector:${json(selector)},catalog:document.querySelector('.workflow-template-catalog')?.textContent,alerts:[...document.querySelectorAll('.workflow-workbench [role="alert"]')].map(node=>node.textContent)})`))
      throw error
    }
    const point = await evaluate(`(${nativeUiPointer.toString()})(${json(selector)}, {timeoutMs:20000,scroll:true,captureReceipt:true})`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await wait(() => evaluate('window.__nativeUiPointerReceipt'), 'native editor receipt')
    const receipt = await evaluate('window.__nativeUiPointerReceipt')
    assert.equal(receipt.trusted && receipt.targetMatched, true, 'untrusted/missed editor click: ' + selector)
  }
  const button = async (label, root = '.workflow-workbench') => {
    await wait(() => evaluate(`(() => { const node=[...document.querySelectorAll(${json(root + ' button')})].find(node=>node.textContent.trim()===${json(label)} && !node.disabled && node.getClientRects().length); if(!node)return false; document.querySelectorAll('[data-template-ui-target]').forEach(node=>node.removeAttribute('data-template-ui-target'));node.dataset.templateUiTarget='yes';return true })()`), 'button ' + label)
    await click('[data-template-ui-target="yes"]')
  }
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers, ...(key === 'a' && modifiers ? { commands: ['selectAll'] } : {}) })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  const replace = async (selector, text) => {
    await click(selector)
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2)
    await cdp.send('Input.insertText', { text })
    try { await wait(() => evaluate(`document.querySelector(${json(selector)})?.value === ${json(text)}`), 'editor input readback') }
    catch (error) {
      console.error('Template input diagnostic', await evaluate(`JSON.stringify({active:document.activeElement?.tagName,readOnly:document.querySelector(${json(selector)})?.readOnly,disabled:document.querySelector(${json(selector)})?.disabled,length:document.querySelector(${json(selector)})?.value.length,prefix:document.querySelector(${json(selector)})?.value.slice(0,120)})`))
      throw error
    }
  }
  const source = () => evaluate(`document.querySelector('.workflow-template-source')?.value`)
  const chooseScope = async kind => {
    // Focus the closed native select, then use Chromium's trusted typeahead.
    // Clicking first opens a macOS popup that CDP keyboard events do not own.
    await evaluate(`document.querySelector('.workflow-template-catalog select').focus()`)
    const text = { builtin: '内', personal: '个', project: '当' }[kind]
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: text })
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: text })
    try {
      await wait(() => evaluate(`document.querySelector('.workflow-template-catalog select')?.value === ${json(kind)} && !document.querySelector('.workflow-template-catalog [role="status"]')`), 'catalog scope ' + kind)
    } catch (error) {
      console.error('Template select diagnostic', await evaluate(`JSON.stringify({value:document.querySelector('.workflow-template-catalog select')?.value,active:document.activeElement?.tagName,alerts:[...document.querySelectorAll('.workflow-workbench [role="alert"]')].map(node=>node.textContent)})`))
      throw error
    }
  }
  const capture = async name => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(screenshots, name + '.png'), Buffer.from(image.data, 'base64'))
  }
  if (bootstrap) {
    await wait(() => evaluate(`Boolean(window.scry?.conversations && document.querySelector('.sidebar'))`), 'production App ready')
    const root = `.sb-proj-head[data-project-path=${json(fixture.workspace)}]`
    await wait(() => evaluate(`Boolean(document.querySelector(${json(root)}))`), 'authorized project sidebar entry')
    if (!await evaluate(`document.querySelector(${json(root)}).getAttribute('aria-expanded') === 'true'`)) await click(root)
    const draft = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
    await click(`.sidebar [data-conversation-id=${json(draft.id)}]`)
    await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${json(draft.id)}`), 'blank conversation workspace selected')
  }
  await button('工作流模板', '.workflow-entry-actions')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-workspace')?.contains(document.activeElement) && document.querySelector('[data-workflow-workspace-tab="templates"][aria-selected="true"]') && document.querySelector('.workflow-template-embedded'))`), 'Templates workspace dialog focus containment')
  const checkFixDraft = await exerciseCheckFixDraft({ evaluate, click, button, replace, source, wait, capture, fixture })
  await chooseScope('builtin')
  await click('.workflow-template-catalog li button')
  await wait(() => evaluate(`document.querySelector('.workflow-template-source')?.readOnly === true`), 'builtin source readonly')
  const originalBuiltin = await source()
  await button('另存为草稿')
  await wait(() => evaluate(`document.querySelector('.workflow-template-source')?.readOnly === false`), 'editable Save As copy')
  let edited = JSON.parse(await source())
  assert.notEqual(edited.templateId, JSON.parse(originalBuiltin).templateId)
  edited.name = 'UI exact source review'
  edited.body.blocks[0].prompt += '\nUI prompt revision'
  const firstSource = JSON.stringify(edited, null, 2) + '\n', path = join(fixture.userData, 'workflows', 'templates', edited.templateId + '.json')
  await replace('.workflow-template-source', firstSource)
  await button('保留草稿')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-template-source')?.value === ${json(firstSource)} && [...document.querySelectorAll('.workflow-actions button')].some(node=>node.textContent==='预览保存差异' && !node.disabled))`), 'validated private candidate')
  await assert.rejects(readFile(path), error => error.code === 'ENOENT')
  await button('预览保存差异')
  assert.equal(await evaluate(`document.querySelector('.workflow-template-review button:last-child').disabled`), true)
  assert.equal(await evaluate(`document.querySelector('.workflow-template-review textarea[aria-label="候选源码"]').value.includes('UI prompt revision')`), true)
  await click('.workflow-template-review input[type="checkbox"]')
  await button('确认写入此修订')
  await wait(async () => await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }) === firstSource, 'first reviewed source publication')
  await capture('workflow-template-save-as')
  await button('模板库')
  await chooseScope('personal')
  const openSaved = async () => {
    await wait(() => evaluate(`Boolean([...document.querySelectorAll('.workflow-template-catalog li button')].find(node=>node.textContent.includes('UI exact source review')))`), 'saved template metadata row')
    await evaluate(`document.querySelectorAll('[data-template-ui-target]').forEach(node=>node.removeAttribute('data-template-ui-target'));[...document.querySelectorAll('.workflow-template-catalog li button')].find(node=>node.textContent.includes('UI exact source review')).dataset.templateUiTarget='yes'`)
    await click('[data-template-ui-target="yes"]')
    await wait(() => evaluate(`Boolean(document.querySelector('.workflow-template-source'))`), 'saved source open')
  }
  await openSaved(); await button('编辑草稿')
  await replace('.workflow-template-source', '{incomplete')
  await button('保留草稿')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-template-editor-grid + [role="alert"]') && [...document.querySelectorAll('.workflow-workspace button')].some(node => node.textContent === '返回聊天' && !node.disabled))`), 'invalid draft retained and workspace close action settled')
  assert.equal(await evaluate(`[...document.querySelectorAll('.workflow-workbench button')].filter(node => ['仅本次使用','预览保存差异'].includes(node.textContent)).every(node => node.disabled)`), true, 'invalid draft must not reuse its valid baseline for preparation or review')
  assert.equal(await readFile(path, 'utf8'), firstSource)
  await button('返回聊天', '.workflow-workspace')
  await button('工作流模板', '.workflow-entry-actions')
  await chooseScope('personal'); await button('保留的草稿')
  await click('.workflow-template-catalog [data-template-validation="invalid"]')
  await wait(() => evaluate(`document.querySelector('.workflow-template-source')?.value === '{incomplete'`), 'retained invalid draft reopened through production API')
  const candidate = edited.body.blocks[0]
  edited.body.blocks = [
    { kind: 'bind', blockId: 'gate', value: { kind: 'literal', value: true } },
    { kind: 'branch', blockId: 'candidateBranch', when: { kind: 'ref', name: 'gate' }, then: candidate, else: { kind: 'bind', blockId: 'skip', value: { kind: 'literal', value: 'skipped' } }, unknown: 'blocked' },
    { ...edited.body.blocks[1], inputRefs: edited.body.blocks[1].inputRefs.map(ref => ref.nodeId === 'candidate' ? { nodeId: 'candidateBranch' } : ref) },
    edited.body.blocks[2]
  ]
  const finalSource = JSON.stringify(edited, null, 2) + '\n'
  await replace('.workflow-template-source', finalSource)
  await button('保留草稿')
  await wait(() => evaluate(`document.querySelector('.workflow-template-structure')?.textContent.includes('candidateBranch · branch')`), 'same-candidate structure')
  assert.equal(await readFile(path, 'utf8'), firstSource)
  await capture('workflow-template-source-and-structure')
  // Electron exposes Page/Emulation, not Chrome's Browser window manager.
  // Resize only this desktop renderer viewport; do not emulate a phone.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false })
  await wait(() => evaluate('innerWidth <= 480'), 'desktop renderer viewport narrow')
  assert.equal(await evaluate(`document.querySelector('.workflow-workbench').getBoundingClientRect().right <= innerWidth`), true)
  await capture('workflow-template-source-narrow')
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await wait(() => evaluate('innerWidth > 780'), 'desktop renderer viewport restored')
  await button('预览保存差异')
  assert.equal(await evaluate(`document.querySelector('.workflow-template-review textarea[aria-label="候选源码"]').value.includes('candidateBranch')`), true)
  await click('.workflow-template-review input[type="checkbox"]'); await button('确认写入此修订')
  await wait(async () => await readFile(path, 'utf8') === finalSource, 'exact reviewed control-flow source')
  await button('编辑草稿'); await button('仅本次使用')
  await replace('textarea[aria-label="参数值（JSON）"]', JSON.stringify({ goal: 'offline editor acceptance', material: 'synthetic material' }))
  await button('准备计划，不发送模型请求')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-modal [data-workflow-action="approve"]'))`), 'canonical explicit-approval preview')
  assert.equal(await readFile(fixture.inputsFile, 'utf8'), callsBefore, 'editing/preparing must not start any Provider')
  await capture('workflow-template-instance-preview')
  await key('Escape', 'Escape', 27)
  await wait(() => evaluate(`!document.querySelector('.workflow-modal')`), 'preview close')
  await button('工作流模板', '.workflow-entry-actions')
  await chooseScope('personal'); await openSaved()
  await button('删除当前定义')
  assert.equal(await readFile(path, 'utf8'), finalSource, 'opening delete confirmation cannot delete')
  await button('确认删除此准确修订', '.workflow-workbench-confirm')
  await wait(async () => { try { await readFile(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error } }, 'confirmed exact definition deletion')
  await button('保留的修订')
  await wait(() => evaluate(`Boolean([...document.querySelectorAll('.workflow-template-history button')].find(node=>node.textContent===${json(hash(finalSource))}))`), 'retained deleted source')
  await evaluate(`[...document.querySelectorAll('.workflow-template-history button')].find(node=>node.textContent===${json(hash(finalSource))}).dataset.templateUiTarget='history'`)
  await click('[data-template-ui-target="history"]')
  await button('恢复为草稿')
  await assert.rejects(readFile(path), error => error.code === 'ENOENT')
  await button('预览保存差异'); await click('.workflow-template-review input[type="checkbox"]'); await button('确认写入此修订')
  await wait(async () => await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }) === finalSource, 'reviewed restoration of same identity')
  await capture('workflow-template-restored')
  await button('返回聊天', '.workflow-workspace')
  const revisionEditor = await exerciseWorkflowRevisionEditor(cdp, evaluate, fixture, { click, replace, key, capture, wait })
  assert.equal(await readFile(fixture.inputsFile, 'utf8'), callsBefore)
  return { checkFixDraft, revisionEditor, test: 'production template editor native input', fixedBuiltinReadOnly: true, saveAsNewIdentity: true, invalidDraftRetained: true, invalidDraftReopened: true, responsiveDesktopViewport: true, fullSourceReview: true, sourceAndStructureSameCandidate: true, exactPublishedBytes: true, explicitApprovalAfterPreparation: true, deletionAndReviewedRestore: true, providerInvocations: 0, templateId: edited.templateId, revisionHash: hash(finalSource) }
}
