import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { conversationFixtureArchivePath } from './conversation-ownership-smoke.mjs'
import { exerciseConversationFork } from './conversation-fork-smoke.mjs'
import { exerciseConversationManagement } from './conversation-management-smoke.mjs'
import { exercisePiAgentSwitch, exerciseConversationImages } from './conversation-agent-switch-smoke.mjs'
import { exerciseConversationDeletion, verifyConversationDeletionRestart } from './conversation-deletion-smoke.mjs'

import { createConversationDriver, json, inputs, ledger, wait, read, preview, settled, sendRequest } from './conversation-smoke-driver.mjs'
import { exerciseConversationHandoff } from './conversation-handoff-smoke.mjs'

export async function exerciseUnifiedConversation(cdp, evaluate, fixture) {
  await wait(() => evaluate(`Boolean(window.scry?.conversations && document.querySelector('.sidebar'))`), 'production App ready')
  const { click, button, key, selectAgent, compose, confirm } = createConversationDriver(cdp, evaluate)
  const { id, aPreview, bPreview, atLatest } = await exerciseConversationHandoff({ cdp, evaluate, fixture, click, button, key, selectAgent, compose, confirm })
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
  const captureNarrow = async (name, selectors = ['.unified-conversation','.conversation-toolbar','.conversation-chat .composer','textarea[aria-label="描述任务"]','.conversation-chat .clibtn']) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 800, deviceScaleFactor: 1, mobile: false })
    try {
      await capture(`${name}-narrow`)
      const bounds = await evaluate(`${json(selectors)}.map(selector=>{const rect=document.querySelector(selector).getBoundingClientRect();return {selector,left:rect.left,right:rect.right,viewport:innerWidth}})`)
      for (const rect of bounds) assert.ok(rect.left >= 0 && rect.right <= rect.viewport + 1,
        `desktop control clipped by an overflow-hidden ancestor: ${JSON.stringify(rect)}`)
    } finally { await cdp.send('Emulation.clearDeviceMetricsOverride') }
  }
  await captureNarrow('preview')
  assert.equal(await evaluate("Boolean(document.querySelector('.unified-conversation .composer-shell'))"), true, 'uses the normal composer')
  await evaluate(`(() => {
    const el=document.querySelector('.conversation-chat .chat');
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
  await wait(() => evaluate(`document.querySelectorAll('.conversation-chat .turn').length === 3 && !document.querySelector('.conversation-chat .composer').textContent.includes('当前轮仍在投递')`), 'final rendered timeline')
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
  assert.deepEqual(stored.turns[1].importedItems, bPreview.missingItems.map(item => item.ref))
  assert.deepEqual(stored.turns[2].importedItems, aPreview.missingItems.map((item) => item.ref))
  const omitted = await preview(evaluate, id, 'codex')
  assert.equal(omitted.missingItems.length, 2)
  assert.ok(omitted.missingItems.every(item => item.ref.runId === final.turns[2].runId), 'confirmed history is never resent')
  const duplicate = { ...sendRequest(aPreview, stored.turns[2].commandId, 'desktop remote write three'), permissionMode: 'default' }
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

  const nativeFork = await exerciseConversationFork({ cdp, evaluate, fixture, click, button, wait, read, preview, settled, sendRequest, inputs, ledger, capture })
  await click(`.sidebar [data-conversation-id=${json(id)}]`)
  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId===${json(id)}`), 'return from native fork fixture')
  await wait(() => evaluate('document.querySelector(\'[aria-label="重命名统一对话"]\')?.disabled===false'), 'returned conversation finished loading')

  const management = await exerciseConversationManagement({ cdp, evaluate, fixture, id, click, button, key, wait, read, inputs, ledger, capture, captureNarrow })

  const deletion = await exerciseConversationDeletion({ cdp, evaluate, fixture, click, button, key, wait, read, preview, settled, sendRequest, inputs, ledger, capture, captureNarrow })

  const piSwitch = await exercisePiAgentSwitch({ cdp, evaluate, fixture, click, wait, inputs, read, settled, ledger })
  const images = await exerciseConversationImages({ cdp, evaluate, fixture, click, wait, inputs, read, preview, settled, sendRequest, capture })

  // Exercise the actual registered legacy/adoption/Steer handlers while a
  // managed Provider is waiting for an answer, not just a store/controller mock.
  const liveConversation = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  const livePreview = await preview(evaluate, liveConversation.id, 'codex')
  const liveRequest = sendRequest(livePreview, 'live-guard-command', 'dock badge question smoke')
  const liveStart = await evaluate(`window.scry.conversations.send(${json(liveRequest)})`)
  const live = await wait(() => evaluate(`window.scry.activeRuns().then(runs=>runs.find(run=>run.runId===${json(liveStart.runId)} && run.pendingQuestions?.length))`), 'live managed question')
  const liveRevision = (await read(evaluate, liveConversation.id)).summary.revision
  assert.match(await evaluate(`window.scry.conversations.update(${json(liveConversation.id)},${liveRevision},{kind:'archive',archived:true}).then(()=>'',error=>String(error))`), /运行|投递未收敛/)
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
  await wait(() => evaluate("Boolean(document.querySelector('.conversation-chat .run-status'))"), 'pending question has a visible composer entry')
  await click('.conversation-chat .run-status')
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
  const unknownEntry = `.sidebar [data-conversation-id=${json(unknown.id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(unknownEntry)}))`), 'unknown logical entry')
  await click(unknownEntry)
  await wait(() => evaluate(`document.querySelector('.conversation-chat .composer-notice')?.textContent.includes(${json(unknownPage.summary.blockedReason)})`), 'unknown delivery remains visible even without a draft')
  assert.equal(await evaluate("document.querySelector('.conversation-chat textarea').value"), '')
  assert.equal(await evaluate("document.querySelector('.conversation-chat .send').disabled"), true)
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
    duplicate, nativeFork, management, deletion, piSwitch, images, runIds: final.turns.map((turn) => turn.runId), receipts: inputs(fixture), screenshots }
}

export async function verifyUnifiedConversationRestart(evaluate, fixture, result, changedIdentity) {
  await wait(() => evaluate('Boolean(window.scry?.conversations)'), 'restarted preload ready')
  const page = await read(evaluate, result.id)
  assert.deepEqual(page.turns.map((turn) => turn.runId), result.runIds)
  assert.equal(page.bindings.length, 2)
  assert.equal(page.summary.lastRunOutcome, 'completed', 'logical completion survives restart')
  assert.ok(page.turns.every((turn) => turn.delivery.status === 'accepted' && turn.history?.done === true))
  assert.equal((await read(evaluate, result.unknownId)).turns[0].delivery.status, 'unknown')
  const pi = await read(evaluate, result.piSwitch.id)
  assert.deepEqual(pi.turns.map(turn => turn.runId), result.piSwitch.runIds)
  const piPlan = await evaluate(`window.scry.conversations.preview(${json(result.piSwitch.id)}, {providerId:'pi',agentProfileId:${json(result.piSwitch.profile)}})`)
  assert.equal(piPlan.continuation.kind, changedIdentity ? 'fresh' : 'resume')
  assert.equal(piPlan.missingItems.length, changedIdentity ? 10 : 0)
  const archiveFailure = await read(evaluate, result.archiveFailure.id)
  assert.equal(archiveFailure.turns[0].delivery.status, 'unknown')
  assert.equal(archiveFailure.summary.lastRunOutcome, undefined, 'unknown delivery must not be displayed as completed')
  assert.equal(archiveFailure.turns[0].history, undefined)
  assert.ok(archiveFailure.summary.blockedReason)
  assert.deepEqual(await evaluate(`window.scry.conversations.send(${json(result.duplicate)})`), { runId: result.runIds[2], disposition: 'duplicate' })
  assert.equal(page.summary.title, result.management.originalTitle)
  assert.ok(page.summary.pinnedAt)
  const adopted = await read(evaluate, result.management.id)
  assert.equal(adopted.turns[0].runId, result.management.runId)
  assert.equal(adopted.turns[0].delivery.status, 'imported')
  assert.equal(adopted.turns[1].runId, result.management.nextRunId)
  assert.equal(adopted.turns[1].delivery.status, 'accepted')
  assert.equal(adopted.bindings.length, 2)
  assert.equal((await evaluate(`window.scry.conversations.adopt(${json(result.management.source)},${json(result.management.fingerprint)})`)).id, result.management.id)
  const next = await preview(evaluate, result.id, 'claude')
  assert.equal(next.continuation.kind, changedIdentity ? 'fresh' : 'resume')
  assert.equal(next.missingItems.length, changedIdentity ? 6 : 0)
  for (const id of [result.nativeFork.sourceId, result.nativeFork.branchId]) {
    assert.equal((await read(evaluate, id)).summary.deletion.status, 'complete')
  }
  const forkCalls = readFileSync(fixture.callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(call => call.operation === 'fork')
  assert.equal(forkCalls.length, result.nativeFork.forkCalls, 'restart cannot recreate the native branch')
  await verifyConversationDeletionRestart(evaluate, fixture, result.deletion, inputs)
  assert.deepEqual(inputs(fixture), result.receipts, 'restart/read/preview/duplicate must not execute the Provider again')
}
