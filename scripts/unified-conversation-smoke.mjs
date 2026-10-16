import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { conversationFixtureArchivePath } from './conversation-ownership-smoke.mjs'

const json = JSON.stringify
const inputs = (fixture) => existsSync(fixture.inputsFile) ? readFileSync(fixture.inputsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const ledger = (fixture, id) => JSON.parse(readFileSync(join(fixture.userData, 'conversations', `${id}.json`), 'utf8'))
const wait = async (probe, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}
const read = (evaluate, id) => evaluate(`window.scry.conversations.read(${json(id)})`)
const preview = (evaluate, id, providerId) => evaluate(`window.scry.conversations.preview(${json(id)}, {providerId:${json(providerId)}})`)
const settled = (evaluate, id, count, status = 'accepted') => wait(async () => {
  const page = await read(evaluate, id)
  return page.turns.length === count && !page.summary.activeRunId && page.turns.at(-1).delivery.status === status ? page : false
}, `conversation ${id}: ${count} turns / ${status}`)
const sendRequest = (view, commandId, prompt, selectedItems = view.missingItems.map((item) => item.ref)) => ({
  conversationId: view.conversationId, providerId: view.target.providerId, expectedRevision: view.revision,
  expectedContinuationKey: view.target.continuationKey, commandId, prompt, selectedItems,
  confirmFresh: view.continuation.kind === 'fresh'
})

export async function exerciseUnifiedConversation(cdp, evaluate, fixture) {
  await wait(() => evaluate(`Boolean(window.scry?.conversations && document.querySelector('.sidebar'))`), 'production App ready')
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${json(selector)});
      if (!node || node.disabled) throw new Error('Missing/enabled UI target: ' + ${json(selector)});
      node.scrollIntoView({block:'nearest'});
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Hidden UI target');
      const x=rect.x+rect.width/2, y=rect.y+rect.height/2;
      if (!node.contains(document.elementFromPoint(x,y))) throw new Error('UI target is occluded: '+${json(selector)});
      return {x,y};
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const button = async (label) => {
    const selector = await evaluate(`(() => {
      const nodes=[...document.querySelectorAll('button')];
      const node=nodes.find(node=>node.textContent.trim()===${json(label)});
      if(!node) throw new Error('Button not found: '+${json(label)});
      node.dataset.unifiedTestTarget='button'; return 'button[data-unified-test-target="button"]';
    })()`)
    await click(selector)
    await evaluate(`document.querySelector('button[data-unified-test-target]')?.removeAttribute('data-unified-test-target')`)
  }
  const key = async (key, code, windowsVirtualKeyCode) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const compose = async (prompt, direction) => {
    await click('textarea[aria-label="统一对话消息"]')
    await cdp.send('Input.insertText', { text: prompt })
    if (direction) {
      const label = direction === 'ArrowDown' ? 'Codex 默认配置' : 'Claude 默认配置'
      const selector = `input[type="radio"][aria-label=${json(label)}]`
      await wait(() => evaluate(`!document.querySelector(${json(selector)})?.disabled && !document.querySelector('.unified-provider')?.disabled`), 'Provider controls settle')
      await click(selector)
      assert.equal(await evaluate(`document.querySelector(${json(selector)}).checked`), true)
    }
    await button('预览并发送')
    await wait(() => evaluate(`Boolean(document.querySelector('.unified-preview'))`), 'history preview opens')
  }
  const confirm = async (fresh) => {
    if (fresh) await click('.unified-preview fieldset > label input[type="checkbox"]')
    await button('确认发送')
    await wait(() => evaluate(`!document.querySelector('.unified-preview')`), 'send accepted by production IPC')
  }
  const rootSelector = `.sb-proj-head[data-project-path=${json(fixture.workspace)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(rootSelector)}))`), 'workspace in sidebar')
  if (!await evaluate(`document.querySelector(${json(rootSelector)}).getAttribute('aria-expanded') === 'true'`)) await click(rootSelector)
  await click('.sb-proj.open .unified-new')
  const id = await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId`), 'logical conversation created through UI')
  await wait(() => evaluate(`!document.querySelector('.unified-composer .btn.primary')?.disabled`)
    .then((enabled) => enabled || evaluate(`document.querySelector('.unified-history')?.textContent.includes('从 Claude')`)), 'conversation loaded')

  await compose('desktop remote write one')
  assert.equal(await evaluate(`document.querySelector('.unified-preview .btn.primary').disabled`), true, 'fresh native context needs explicit confirmation')
  await key('Escape', 'Escape', 27)
  await wait(() => evaluate(`!document.querySelector('.unified-preview')`), 'Escape cancels preview')
  await wait(() => evaluate('document.activeElement?.textContent.trim() === "预览并发送"'), 'cancel restores preview trigger focus')
  await button('预览并发送')
  await wait(() => evaluate(`Boolean(document.querySelector('.unified-preview'))`), 'preview reopened for button cancellation')
  await button('取消，不发送')
  assert.equal(inputs(fixture).length, 0, 'cancelled preview must not enter either Provider')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="统一对话消息"]').value`), 'desktop remote write one')
  await click('.sb-proj.open .unified-new')
  await wait(() => evaluate(`(() => { const selected = document.querySelector('.unified-conversation')?.dataset.conversationId; return selected && selected !== ${json(id)} })()`), 'switch to an independent draft')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="统一对话消息"]').value`), '')
  const originalEntry = `.sidebar [data-conversation-id=${json(id)}]`
  await click(originalEntry)
  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId === ${json(id)}`), 'return to original draft')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="统一对话消息"]').value`), 'desktop remote write one')
  const documentEpoch = await evaluate('performance.timeOrigin')
  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: true })
  await wait(async () => {
    try { return await evaluate(`performance.timeOrigin !== ${documentEpoch} && Boolean(window.scry?.conversations && document.querySelector('.sidebar'))`) }
    catch (error) {
      if (/context.*destroyed|Cannot find.*context|Inspected target navigated/i.test(String(error))) return false
      throw error
    }
  }, 'renderer reload')
  await wait(() => evaluate(`Boolean(document.querySelector(${json(rootSelector)}))`), 'workspace after reload')
  if (!await evaluate(`document.querySelector(${json(rootSelector)}).getAttribute('aria-expanded') === 'true'`)) await click(rootSelector)
  await wait(() => evaluate(`Boolean(document.querySelector(${json(originalEntry)}))`), 'logical entry after reload')
  await click(originalEntry)
  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId === ${json(id)}`), 'draft restored after reload')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="统一对话消息"]').value`), 'desktop remote write one')
  assert.equal(inputs(fixture).length, 0, 'switching and reloading drafts must not send')
  await evaluate(`window.__unifiedLegacyFocus = []; window.scry.onFocusedRun(run => window.__unifiedLegacyFocus.push(run.runId))`)
  await wait(() => evaluate(`!document.querySelector('.unified-composer .btn.primary')?.disabled`), 'restored conversation ready')
  await button('预览并发送')
  await wait(() => evaluate(`Boolean(document.querySelector('.unified-preview'))`), 'preview reopened')
  await confirm(true)
  const first = await settled(evaluate, id, 1)
  assert.equal(first.turns[0].providerId, 'claude')
  assert.equal(readFileSync(join(fixture.workspace, 'remote-first.txt'), 'utf8'), 'remote-first.txt\n')

  const bPreview = await preview(evaluate, id, 'codex')
  assert.equal(bPreview.missingItems.length, 2)
  await compose('desktop remote write two', 'ArrowDown')
  assert.equal(await evaluate(`document.querySelector('input[aria-label="Codex 默认配置"]').checked`), true)
  await click('.unified-history-selection > div:nth-child(2) summary')
  await wait(() => evaluate(`document.querySelector('.unified-history-body')?.textContent === 'isolated remote assistant evidence'`), 'full authoritative assistant text is previewed')
  assert.equal(await evaluate(`window.scry.conversations.readItem(${json(id)},${json(bPreview.missingItems[0].ref)})`), 'desktop remote write one')
  const forgedRef = { ...bPreview.missingItems[0].ref, contentHash: '0'.repeat(64) }
  assert.match(await evaluate(`window.scry.conversations.readItem(${json(id)},${json(forgedRef)}).then(()=>null,error=>String(error))`), /不属于当前对话/)
  assert.match(await evaluate(`window.scry.conversations.readItem(${json(id)},${json({ ...bPreview.missingItems[0].ref, path: '/etc/passwd' })}).then(()=>null,error=>String(error))`), /格式或字段/)
  assert.equal(inputs(fixture).length, 1, 'reading preview bodies must not invoke a Provider')
  await click('.unified-history-selection > div:nth-child(2) input')
  await confirm(true)
  const second = await settled(evaluate, id, 2)
  assert.equal(second.turns[1].providerId, 'codex')
  assert.equal(readFileSync(join(fixture.workspace, 'remote-second.txt'), 'utf8'), 'remote-second.txt\n')

  const atLatest = `(() => { const el=document.querySelector('.unified-history'); return el && el.scrollHeight-el.clientHeight-el.scrollTop < 2 })()`
  await wait(() => evaluate(`document.querySelectorAll('.unified-turn').length === 2 && ${atLatest}`), 'new output follows the transcript bottom')
  const wheelPoint = await evaluate(`(() => {const rect=document.querySelector('.unified-history').getBoundingClientRect();return {x:rect.left+10,y:rect.top+30}})()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -10000 })
  await wait(() => evaluate(`document.querySelector('.unified-history').scrollTop === 0 && !${atLatest}`), 'user scroll leaves bottom following')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false })
  try {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert.equal(await evaluate("document.querySelector('.unified-history').scrollTop"), 0, 'layout changes must preserve the user reading older output')
  } finally { await cdp.send('Emulation.clearDeviceMetricsOverride') }

  const aPreview = await preview(evaluate, id, 'claude')
  assert.equal(aPreview.continuation.kind, 'resume')
  assert.deepEqual(aPreview.missingItems.map((item) => item.ref.runId), [second.turns[1].runId, second.turns[1].runId])
  await compose('desktop remote write three', 'ArrowUp')
  assert.equal(await evaluate(`document.querySelector('.unified-preview').textContent.includes('恢复兼容的原生上下文')`), true)
  const screenshots = mkdtempSync(join(tmpdir(), 'scry-unified-rendering-'))
  const capture = async (name) => {
    for (const theme of ['dark', 'light']) {
      await evaluate(`(async () => {
        document.documentElement.dataset.theme=${json(theme)};
        await new Promise(resolve=>requestAnimationFrame(resolve));
        await Promise.allSettled(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished));
        await new Promise(resolve=>requestAnimationFrame(resolve));
      })()`)
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(join(screenshots, `${name}-${theme}.png`), Buffer.from(image.data, 'base64'))
    }
  }
  await capture('preview')
  const captureNarrow = async (name) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 800, deviceScaleFactor: 1, mobile: false })
    try {
      await capture(`${name}-narrow`)
      const bounds = await evaluate(`['.unified-conversation','.unified-header','.unified-pagination','.unified-composer','textarea[aria-label="统一对话消息"]','.unified-provider','.unified-scope'].map(selector=>{const rect=document.querySelector(selector).getBoundingClientRect();return {selector,left:rect.left,right:rect.right,viewport:innerWidth}})`)
      for (const rect of bounds) assert.ok(rect.left >= 0 && rect.right <= rect.viewport + 1,
        `desktop control clipped by an overflow-hidden ancestor: ${JSON.stringify(rect)}`)
    } finally { await cdp.send('Emulation.clearDeviceMetricsOverride') }
  }
  await captureNarrow('preview')
  const padding = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.unified-preview')).paddingLeft)`)
  assert.ok(padding >= 20, 'real CSS cascade must retain dialog content padding')
  await evaluate(`(() => {
    const el=document.querySelector('.unified-history');
    window.__scrollEvidence=[];
    const sample=kind=>{if(window.__scrollEvidence.length<80) window.__scrollEvidence.push({kind,top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight,turns:el.children.length,focus:document.activeElement?.className})};
    const resize=new ResizeObserver(()=>sample('resize'));
    const mutation=new MutationObserver(()=>sample('mutation'));
    const scroll=()=>sample('scroll');
    el.addEventListener('scroll',scroll);resize.observe(el);mutation.observe(el,{childList:true,subtree:true});sample('before-send');
    window.__stopScrollEvidence=()=>{resize.disconnect();mutation.disconnect();el.removeEventListener('scroll',scroll)};
  })()`)
  await confirm(false)
  const final = await settled(evaluate, id, 3)
  assert.equal(readFileSync(join(fixture.workspace, 'remote-third.txt'), 'utf8'), 'remote-third.txt\n')
  assert.equal(final.summary.id, id)
  await wait(() => evaluate(`document.querySelectorAll('.unified-turn').length === 3 && !document.querySelector('.unified-composer').textContent.includes('当前轮仍在投递')`), 'final rendered timeline')
  try { await wait(() => evaluate(atLatest), 'sending explicitly returns to latest output') }
  catch (error) { throw new Error(`${error.message}: ${JSON.stringify(await evaluate('window.__scrollEvidence'))}`) }
  finally { await evaluate('window.__stopScrollEvidence()') }
  await capture('timeline')
  await captureNarrow('timeline')
  assert.equal(final.bindings.length, 2)
  assert.deepEqual(final.turns.map((turn) => turn.providerId), ['claude', 'codex', 'claude'])
  assert.deepEqual(await evaluate('window.__unifiedLegacyFocus'), [], 'logical runs must not adopt the hidden native composer')
  const receipts = inputs(fixture)
  assert.equal(receipts.length, 3)
  assert.equal(receipts[0].resume, null)
  assert.equal(receipts[1].resume, null)
  assert.equal(receipts[2].resume, receipts[0].sessionId, 'A→B→A must reuse the original A native context')
  for (const receipt of receipts) {
    if (receipt.historicalContext) {
      assert.equal(createHash('sha256').update(receipt.historicalContext.text).digest('hex'), receipt.historicalContext.contentHash)
      assert.ok(receipt.outgoingPrompt.endsWith(`[Current user request]\n${receipt.prompt}`))
      assert.ok(!receipt.historicalContext.text.includes('smoke fixture result Authorization'), 'tool execution must not be replayed as history')
    } else assert.equal(receipt.outgoingPrompt, receipt.prompt)
  }
  const stored = ledger(fixture, id)
  assert.deepEqual(stored.turns[1].importedItems, [bPreview.missingItems[0].ref])
  assert.deepEqual(stored.turns[2].importedItems, aPreview.missingItems.map((item) => item.ref))
  const omitted = await preview(evaluate, id, 'codex')
  assert.equal(omitted.missingItems.length, 3)
  assert.ok(omitted.missingItems.some((item) => item.ref.runId === first.turns[0].runId && item.role === 'assistant'), 'early omission must survive later native coverage')
  const duplicate = sendRequest(aPreview, stored.turns[2].commandId, 'desktop remote write three')
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(duplicate)})`), { runId: final.turns[2].runId, disposition: 'duplicate' })
  const stale = { ...duplicate, commandId: 'stale-ui-preview', expectedRevision: 0 }
  const error = await evaluate(`window.scry.conversations.send(${json(stale)}).then(()=>null,error=>String(error))`)
  assert.match(error ?? '', /对话已变化，请重新预览/)
  assert.equal(inputs(fixture).length, 3)
  const catalog = await evaluate('window.scry.listProjects()')
  const project = catalog.find((project) => project.cwd === fixture.workspace)
  assert.equal(project.conversations.filter((conversation) => conversation.id === id).length, 1)
  assert.ok(project.sessions.every((session) => !receipts.some((receipt) => receipt.providerId === session.providerId && receipt.sessionId === session.externalSessionId)))
  await wait(() => evaluate(`document.querySelectorAll('.sidebar [data-conversation-id=${json(id)}]').length === 1`), 'one stable sidebar entry')
  for (const turn of final.turns) {
    assert.equal(turn.delivery.status, 'accepted')
    assert.equal(turn.history?.done, true)
    assert.ok(turn.history.items.some((item) => item.kind === 'model' && item.text === 'isolated remote assistant evidence'))
  }

  // Exercise the actual registered legacy/adoption/Steer handlers while a
  // managed Provider is waiting for an answer, not just a store/controller mock.
  const liveConversation = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  const livePreview = await preview(evaluate, liveConversation.id, 'codex')
  const liveRequest = sendRequest(livePreview, 'live-guard-command', 'dock badge question smoke')
  const liveStart = await evaluate(`window.scry.conversations.send(${json(liveRequest)})`)
  const live = await wait(() => evaluate(`window.scry.activeRuns().then(runs=>runs.find(run=>run.runId===${json(liveStart.runId)} && run.pendingQuestions?.length))`), 'live managed question')
  const callsBefore = inputs(fixture)
  const bypass = await evaluate(`window.scry.start({providerId:'codex',cwd:${json(fixture.workspace)},prompt:'legacy bypass must not run',expectedExternalSessionId:null}).then(()=>null,error=>String(error))`)
  assert.match(bypass ?? '', /统一对话仍在执行或保存证据/)
  const adoption = await evaluate(`window.scry.adoptActiveRun(${json(liveStart.runId)}).then(()=>null,error=>String(error))`)
  assert.match(adoption ?? '', /统一对话不能由旧会话入口接管/)
  const steer = await evaluate(`window.scry.steer(${json({ runId: liveStart.runId, providerId: 'codex', cwd: fixture.workspace,
    expectedExternalSessionId: live.externalSessionId, messageId: 'blocked-managed-steer', prompt: 'must not send', attachments: [] })})`)
  assert.equal(steer.status, 'unavailable')
  assert.match(steer.message, /统一对话暂不支持 Steer/)
  assert.deepEqual(inputs(fixture), callsBefore, 'legacy and Steer refusals must not enter an available Provider handler')
  const liveEntry = `.sidebar [data-conversation-id=${json(liveConversation.id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(liveEntry)}))`), 'live logical entry')
  await click(liveEntry)
  await wait(() => evaluate("Boolean(document.querySelector('.unified-question-jump'))"), 'pending question has a visible composer entry')
  await click('.unified-question-jump')
  for (let step = 1; step <= 2; step++) {
    const question = await wait(() => evaluate(`window.scry.activeRuns().then(runs=>runs.find(run=>run.runId===${json(liveStart.runId)})?.pendingQuestions?.find(question=>question.questionId===${json(`${liveStart.runId}:question:`)}+${step}))`), 'next live question')
    const choice = `.unified-conversation .question-option:not(.question-other):has(input[name=${json(`question-${question.questionId}-0`)}])`
    await wait(() => evaluate(`Boolean(document.querySelector(${json(choice)}))`), 'question rendered in unified timeline')
    await click(choice)
    await click('.unified-conversation .question-submit')
    await wait(() => evaluate(`window.scry.activeRuns().then(runs=>!runs.find(run=>run.runId===${json(liveStart.runId)})?.pendingQuestions?.some(question=>question.questionId===${json(question.questionId)}))`), 'UI answer accepted')
  }
  await settled(evaluate, liveConversation.id, 1)
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(liveRequest)})`), { runId: liveStart.runId, disposition: 'duplicate' })

  // A completed result is not an input receipt. Persist unknown and never retry it.
  const unknown = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  const unknownView = await preview(evaluate, unknown.id, 'codex')
  const unknownRequest = sendRequest(unknownView, 'unknown-command', 'conversation unknown input')
  const unknownRun = await evaluate(`window.scry.conversations.send(${json(unknownRequest)})`)
  const unknownPage = await settled(evaluate, unknown.id, 1, 'unknown')
  assert.ok(unknownPage.summary.blockedReason)
  assert.equal(await evaluate(`window.scry.conversations.preview(${json(unknown.id)},{providerId:'claude'}).then(()=>false,()=>true)`), true)
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(unknownRequest)})`), { runId: unknownRun.runId, disposition: 'duplicate' })
  // Block the real per-session archive directory with a fixture file while the
  // Provider is awaiting input. Native acceptance must not survive as accepted
  // coverage when production persistence fails (including its terminal cleanup).
  const archiveFailure = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  const archiveRequest = sendRequest(await preview(evaluate, archiveFailure.id, 'codex'), 'archive-failure-command', 'dock badge question smoke')
  const archiveStart = await evaluate(`window.scry.conversations.send(${json(archiveRequest)})`)
  const archiveLive = await wait(() => evaluate(`window.scry.activeRuns().then(runs=>runs.find(run=>run.runId===${json(archiveStart.runId)} && run.pendingQuestions?.length))`), 'accepted input before archive fault')
  const nativeReceipt = archiveLive.items.find(item => item.runtimeMetadata?.inputReceipt?.status === 'accepted')?.runtimeMetadata.inputReceipt
  assert.equal(nativeReceipt?.status, 'accepted', 'the persistence fault must occur after native input acceptance')
  const archivePath = conversationFixtureArchivePath(fixture.userData, fixture.workspace, archiveLive.externalSessionId, `${archiveStart.runId}:provider-turn`)
  const blocker = dirname(archivePath)
  mkdirSync(dirname(blocker), { recursive: true })
  writeFileSync(blocker, 'isolated archive failure fixture', { flag: 'wx' })
  for (let step = 1; step <= 2; step++) {
    const questionId = `${archiveStart.runId}:question:${step}`
    await wait(() => evaluate(`window.scry.activeRuns().then(runs=>runs.find(run=>run.runId===${json(archiveStart.runId)})?.pendingQuestions?.some(question=>question.questionId===${json(questionId)}))`), 'archive-fault question')
    assert.equal(await evaluate(`window.scry.answerQuestion(${json({ runId: archiveStart.runId, questionId, behavior: 'answered', answers: { 'Continue the isolated badge smoke?': 'Continue' } })})`), true)
  }
  const failedArchive = await settled(evaluate, archiveFailure.id, 1, 'unknown')
  assert.ok(failedArchive.summary.blockedReason)
  assert.equal(failedArchive.turns[0].history, undefined)
  assert.deepEqual(ledger(fixture, archiveFailure.id).turns[0].items, [])
  assert.equal(existsSync(archivePath), false)
  assert.equal(await evaluate(`window.scry.conversations.preview(${json(archiveFailure.id)},{providerId:'claude'}).then(()=>false,()=>true)`), true)
  const invocationCount = inputs(fixture).length
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(archiveRequest)})`), { runId: archiveStart.runId, disposition: 'duplicate' })
  assert.equal(inputs(fixture).length, invocationCount)
  return { test: 'production unified conversation UI and IPC', id, unknownId: unknown.id,
    archiveFailure: { id: archiveFailure.id, runId: archiveStart.runId, nativeReceipt, delivery: failedArchive.turns[0].delivery },
    duplicate, runIds: final.turns.map((turn) => turn.runId), receipts: inputs(fixture), screenshots }
}

export async function verifyUnifiedConversationRestart(evaluate, fixture, result, changedIdentity) {
  await wait(() => evaluate('Boolean(window.scry?.conversations)'), 'restarted preload ready')
  const page = await read(evaluate, result.id)
  assert.deepEqual(page.turns.map((turn) => turn.runId), result.runIds)
  assert.equal(page.bindings.length, 2)
  assert.ok(page.turns.every((turn) => turn.delivery.status === 'accepted' && turn.history?.done === true))
  assert.equal((await read(evaluate, result.unknownId)).turns[0].delivery.status, 'unknown')
  const archiveFailure = await read(evaluate, result.archiveFailure.id)
  assert.equal(archiveFailure.turns[0].delivery.status, 'unknown')
  assert.equal(archiveFailure.turns[0].history, undefined)
  assert.ok(archiveFailure.summary.blockedReason)
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(result.duplicate)})`), { runId: result.runIds[2], disposition: 'duplicate' })
  const next = await preview(evaluate, result.id, 'claude')
  assert.equal(next.continuation.kind, changedIdentity ? 'fresh' : 'resume')
  assert.equal(next.missingItems.length, changedIdentity ? 6 : 0)
  assert.deepEqual(inputs(fixture), result.receipts, 'restart/read/preview/duplicate must not execute the Provider again')
}
