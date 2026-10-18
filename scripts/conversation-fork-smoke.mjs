import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { conversationFixtureArchivePath } from './conversation-ownership-smoke.mjs'

const json = JSON.stringify

export async function exerciseConversationFork({ cdp, evaluate, fixture, click, button, wait, read, preview, settled, sendRequest, inputs, ledger, capture }) {
  const calls = () => existsSync(fixture.callsFile) ? readFileSync(fixture.callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  const pick = async id => {
    const selector = `.sidebar [data-conversation-id=${json(id)}]`
    await wait(() => evaluate(`Boolean(document.querySelector(${json(selector)}))`), 'fork conversation in sidebar')
    const closed = await evaluate(`(() => {const group=document.querySelector(${json(selector)}).closest('details');if(!group||group.open)return false;group.dataset.forkTest='true';return true})()`)
    if (closed) await click('[data-fork-test] > summary')
    await click(selector)
    await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId===${json(id)}`), 'fork conversation selected')
  }
  const idle = id => wait(() => evaluate(`window.scry.conversations.previewDeletion(${json(id)}).then(()=>true,error=>{
    if(String(error).includes('请先存档'))return true;
    if(String(error).includes('运行或证据保存未收敛'))return false;
    throw error;
  })`), 'fork source runtime settled')
  const archive = async id => {
    await idle(id)
    await pick(id)
    await click('[aria-label="存档统一对话"]')
    await wait(() => evaluate(`!document.querySelector('.sidebar [data-conversation-id=${json(id)}]') && Boolean(document.querySelector('[aria-label="删除统一对话"]'))`), 'archived fork stays open for deletion but leaves the sidebar')
  }
  const remove = async () => {
    await wait(() => evaluate('document.querySelector(\'[aria-label="删除统一对话"]\')?.disabled===false'), 'loaded recovery action')
    await click('[aria-label="删除统一对话"]')
    await wait(() => evaluate("document.querySelector('.unified-delete .danger')?.disabled===false"), 'fork deletion preview ready')
    await click('.unified-delete .danger')
    await wait(() => evaluate("Boolean(document.querySelector('.unified-delete section[role=status]'))"), 'fork deletion receipt')
    await button('关闭')
  }

  const source = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  for (const [index, providerId] of ['claude', 'codex'].entries()) {
    const request = sendRequest(await preview(evaluate, source.id, providerId), `fork-source-${index}`, `fork source ${providerId}`)
    await evaluate(`window.scry.conversations.send(${json(request)})`)
    await settled(evaluate, source.id, index + 1)
  }
  await idle(source.id)
  await pick(source.id)
  await wait(() => evaluate("document.querySelector('.unified-conversation .clibtn')?.disabled===false"), 'fork Agent selection ready')
  await click('.unified-conversation .clibtn')
  await click('.climenu .mitem[data-agent-id="claude"]')
  await wait(() => evaluate("document.querySelector('.clibtn')?.dataset.agentId==='claude'"), 'current Agent differs from selected turn owner')
  await click('textarea[aria-label="描述任务"]')
  await cdp.send('Input.insertText', { text: 'source draft survives native fork' })
  const original = ledger(fixture, source.id)
  const sourceText = json(original)
  const selected = original.turns[1]
  const selectedBinding = original.bindings.find(binding => binding.id === selected.bindingId)
  const beforeInputs = inputs(fixture)
  const beforeForks = calls().filter(call => call.operation === 'fork').length
  const sourceArchives = original.turns.map(turn => conversationFixtureArchivePath(fixture.userData, fixture.workspace, turn.archive.sessionId,
    turn.archive.providerTurnId, original.bindings.find(binding => binding.id === turn.bindingId).providerId))
  const archiveBytes = sourceArchives.map(path => readFileSync(path))
  const branchButton = `.turn[data-run-id=${json(selected.runId)}] .turn-branch-btn`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(branchButton)}))`), 'selected native turn fork action')
  await click(branchButton)
  // The isolated main entry loses exactly one successful IPC reply AFTER native fork and durable publication.
  await wait(() => evaluate("[...document.querySelectorAll('.conversation-recovery button')].some(node=>node.textContent==='核对 / 继续原分支'&&!node.disabled)"), 'lost fork reply recovery')
  assert.equal(await evaluate("document.querySelector('.unified-conversation').dataset.conversationId"), source.id)
  assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"描述任务\"]').value"), 'source draft survives native fork')
  assert.equal(await evaluate("document.querySelector('.send').disabled"), true)
  assert.deepEqual(inputs(fixture), beforeInputs, 'fork never submits a user message')
  await button('核对 / 继续原分支')
  const branchId = await wait(() => evaluate(`(() => {const id=document.querySelector('.unified-conversation')?.dataset.conversationId;return id&&id!==${json(source.id)}?id:false})()`), 'durable native branch opened')
  let branch = ledger(fixture, branchId)
  assert.equal(branch.fork.status, 'accepted')
  assert.equal(branch.fork.sourceRunId, selected.runId)
  assert.deepEqual(branch.turns.map(turn => turn.runId), original.turns.map(turn => turn.runId))
  assert.ok(branch.turns.every(turn => turn.origin === 'imported' && turn.nativeItems.length === 0))
  const nativeBinding = branch.bindings.find(binding => binding.id === branch.fork.bindingId)
  assert.equal(nativeBinding.providerId, 'codex', 'route by the selected turn, not the currently selected Claude')
  assert.notEqual(nativeBinding.nativeSessionId, selectedBinding.nativeSessionId)
  assert.equal(json(ledger(fixture, source.id)), sourceText, 'fork does not mutate the source ledger')
  assert.deepEqual(calls().filter(call => call.operation === 'fork').slice(beforeForks), [{ operation: 'fork', identity: selectedBinding.nativeSessionId }])
  await wait(() => evaluate("document.querySelector('.clibtn')?.dataset.agentId==='codex' && !document.querySelector('.turn-branch-btn')"), 'shared history has no writable fork action')
  await capture('native-fork')

  await click('textarea[aria-label="描述任务"]')
  await cdp.send('Input.insertText', { text: 'continue the native branch' })
  await button('发送')
  await settled(evaluate, branchId, 3)
  assert.equal(inputs(fixture).at(-1).resume, nativeBinding.nativeSessionId)
  assert.equal(inputs(fixture).at(-1).historicalContext, null, 'confirmed inherited history is not replayed')
  await idle(branchId)
  branch = ledger(fixture, branchId)
  assert.equal(json(ledger(fixture, source.id)), sourceText)
  await button('打开源对话')
  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId===${json(source.id)}`), 'open the source owner from its branch')
  await wait(() => evaluate("document.querySelector('textarea[aria-label=\"描述任务\"]').value==='source draft survives native fork'"), 'source draft survives returning')

  await archive(source.id)
  const shared = await evaluate(`window.scry.conversations.previewDeletion(${json(source.id)})`)
  assert.ok(shared.targets.every(target => target.sharedWith.includes(branchId)))
  const callsBeforeCleanup = calls()
  await remove()
  assert.equal(ledger(fixture, source.id).deletion.retainedCopies, true)
  sourceArchives.forEach((path, index) => assert.deepEqual(readFileSync(path), archiveBytes[index]))
  assert.ok((await read(evaluate, branchId)).turns.slice(0, 2).every(turn => turn.history), 'shared history survives deleting its original logical owner')
  const retained = await evaluate(`window.scry.conversations.previewDeletion(${json(source.id)})`)
  assert.equal(retained.reclaim, true)
  assert.ok(retained.targets.every(target => target.sharedWith.includes(branchId)), 'reclaim still respects live references')
  await click('[aria-label="删除统一对话"]')
  await wait(() => evaluate("document.querySelector('.unified-delete h2')?.textContent.includes('回收')"), 'explicit shared-copy recovery dialog')
  await capture('shared-copy-reclaim')
  await button('取消')

  // Archived entries intentionally have no sidebar recovery route. Keep the source
  // open to exercise its reclaim UI, and remove the other owner via production IPC.
  await idle(branchId)
  const branchPage = await read(evaluate, branchId)
  await evaluate(`window.scry.conversations.update(${json(branchId)},${branchPage.summary.revision},{kind:'archive',archived:true})`)
  const lastOwner = await evaluate(`window.scry.conversations.previewDeletion(${json(branchId)})`)
  assert.ok(lastOwner.targets.every(target => target.sharedWith.length === 0))
  const branchDeletion = await evaluate(`window.scry.conversations.delete(${json(branchId)},${json(lastOwner.fingerprint)})`)
  assert.equal(branchDeletion.ok, true)
  assert.equal(ledger(fixture, branchId).deletion.status, 'complete')
  sourceArchives.forEach(path => assert.equal(existsSync(path), false, 'last explicit owner cleanup removes shared App archives'))
  assert.equal(await evaluate("document.querySelector('.unified-conversation')?.dataset.conversationId"), source.id)
  assert.match(await evaluate(`window.scry.conversations.delete(${json(source.id)},${json(retained.fingerprint)}).then(()=>'',error=>String(error))`), /删除范围已变化/)
  assert.equal(ledger(fixture, source.id).deletion.retainedCopies, true)
  const reclaim = await evaluate(`window.scry.conversations.previewDeletion(${json(source.id)})`)
  assert.equal(reclaim.reclaim, true)
  assert.ok(reclaim.targets.every(target => target.sharedWith.length === 0))
  await remove()
  const reclaimed = ledger(fixture, source.id)
  assert.equal(reclaimed.deletion.status, 'complete')
  assert.equal(reclaimed.deletion.retainedCopies, undefined)
  assert.deepEqual(calls(), callsBeforeCleanup, 'copy deletion and reclaim never call a Provider')
  const visible = await evaluate(`window.scry.conversations.list(${json(fixture.workspace)})`)
  assert.ok(visible.every(item => item.id !== source.id && item.id !== branchId))
  assert.equal(readdirSync(join(fixture.userData, 'conversations')).filter(name => name.endsWith('.json')).map(name =>
    JSON.parse(readFileSync(join(fixture.userData, 'conversations', name), 'utf8'))).filter(item => item.fork?.sourceConversationId === source.id).length, 1)
  return { sourceId: source.id, branchId, nativeSessionId: nativeBinding.nativeSessionId, forkCalls: 1, sharedCopiesReclaimed: true }
}
