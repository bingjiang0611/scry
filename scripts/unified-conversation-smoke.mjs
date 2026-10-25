import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { conversationFixtureArchivePath } from './conversation-ownership-smoke.mjs'
import { exerciseConversationFork } from './conversation-fork-smoke.mjs'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { exerciseConversationManagement } from './conversation-management-smoke.mjs'
import { exercisePiAgentSwitch, exerciseConversationImages } from './conversation-agent-switch-smoke.mjs'
import { exerciseConversationDeletion, verifyConversationDeletionRestart } from './conversation-deletion-smoke.mjs'

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
    if (await evaluate(`Boolean(document.querySelector(${json(selector)})?.closest('.conversation-options:not([open]) .unified-management'))`)) {
      await click('.conversation-options > summary')
    }
    await wait(() => evaluate(`Boolean(document.querySelector(${json(selector)}) && !document.querySelector(${json(selector)}).disabled)`), `enabled UI target: ${selector}`)
    const point = await evaluate(`(${nativeUiPointer.toString()})(${json(selector)}, { timeoutMs: 20000, scroll: true, captureReceipt: true })`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await wait(() => evaluate('window.__nativeUiPointerReceipt'), 'native pointer receipt')
    const receipt = await evaluate('window.__nativeUiPointerReceipt')
    assert.equal(receipt.trusted && receipt.targetMatched, true, `Native click missed ${selector}: ${json(receipt)}`)
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
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const selectAgent = async agentId => {
    await wait(() => evaluate("document.querySelector('.unified-conversation .clibtn')?.disabled === false"), 'Agent picker available')
    await click('.unified-conversation .clibtn')
    await click(`.climenu .mitem[data-agent-id="${agentId}"]`)
    await wait(() => evaluate(`document.querySelector('.unified-conversation .clibtn')?.dataset.agentId === ${json(agentId)}`), 'next Agent selected')
  }
  const compose = async (prompt, direction) => {
    await click('textarea[aria-label="描述任务"]')
    await cdp.send('Input.insertText', { text: prompt })
    if (direction) await selectAgent(direction === 'ArrowDown' ? 'codex' : 'claude')
  }
  const confirm = async () => {
    await wait(() => evaluate("document.querySelector('.unified-conversation .send')?.disabled === false"), 'send ready')
    await button('发送')
    await wait(() => evaluate(`document.querySelector('textarea[aria-label="描述任务"]').value === ''`), 'send registered by production IPC')
    assert.equal(await evaluate("Boolean(document.querySelector('.unified-preview:not(.unified-delete):not(.unified-adoption)'))"), false, 'normal sends never open a history confirmation dialog')
  }
  const rootSelector = `.sb-proj-head[data-project-path=${json(fixture.workspace)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(rootSelector)}))`), 'workspace in sidebar')
  if (!await evaluate(`document.querySelector(${json(rootSelector)}).getAttribute('aria-expanded') === 'true'`)) await click(rootSelector)
  // Seed blank managed drafts through the production API. User-facing entry is
  // the ordinary Agent picker, exercised below with real legacy captures.
  const openDraft = async () => {
    const created = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
    const entry = `.sidebar [data-conversation-id=${json(created.id)}]`
    await wait(() => evaluate(`Boolean(document.querySelector(${json(entry)}))`), 'seeded draft in sidebar')
    await click(entry)
    await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${json(created.id)}`), 'draft opens in normal chat')
    return created.id
  }
  const id = await openDraft()
  assert.equal(await evaluate("Boolean(document.querySelector('.unified-new'))"), false, 'no separate unified-chat creation entry')
  await wait(() => evaluate("document.querySelector('.unified-conversation .clibtn')?.disabled === false"), 'conversation loaded')
  await compose('desktop remote write one')
  await selectAgent('codex')
  await selectAgent('claude')
  assert.equal(inputs(fixture).length, 0, 'changing Agents must not enter either Provider')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="描述任务"]').value`), 'desktop remote write one')
  await openDraft()
  await wait(() => evaluate(`(() => { const selected = document.querySelector('.unified-conversation')?.dataset.conversationId; return selected && selected !== ${json(id)} })()`), 'switch to an independent draft')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="描述任务"]').value`), '')
  const originalEntry = `.sidebar [data-conversation-id=${json(id)}]`
  await click(originalEntry)
  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId === ${json(id)}`), 'return to original draft')
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="描述任务"]').value`), 'desktop remote write one')
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
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="描述任务"]').value`), 'desktop remote write one')
  assert.equal(inputs(fixture).length, 0, 'switching and reloading drafts must not send')
  await evaluate(`window.__unifiedLegacyFocus = []; window.scry.onFocusedRun(run => window.__unifiedLegacyFocus.push(run.runId))`)
  await confirm()
  const first = await settled(evaluate, id, 1)
  assert.equal(first.turns[0].providerId, 'claude')
  assert.equal(first.summary.lastRunOutcome, 'completed', 'logical completion comes from the real settled receipt')
  await click('.sb-view-tabs [role="tab"][id$="-activity"]')
  await wait(() => evaluate(`document.querySelector('.sb-activity [data-conversation-id="${id}"]')?.closest('[data-activity-group]')?.dataset.activityGroup === 'completed'`), 'real logical result appears in completed')
  await click('.sb-view-tabs [role="tab"][id$="-projects"]')
  assert.equal(readFileSync(join(fixture.workspace, 'remote-first.txt'), 'utf8'), 'remote-first.txt\n')

  const bPreview = await preview(evaluate, id, 'codex')
  assert.equal(bPreview.missingItems.length, 2)
  await compose('desktop remote write two', 'ArrowDown')
  assert.equal(await evaluate("document.querySelector('.clibtn').dataset.agentId"), 'codex')
  assert.equal(await evaluate(`window.scry.conversations.readItem(${json(id)},${json(bPreview.missingItems[1].ref)})`), 'isolated remote assistant evidence')
  assert.equal(await evaluate(`window.scry.conversations.readItem(${json(id)},${json(bPreview.missingItems[0].ref)})`), 'desktop remote write one')
  const forgedRef = { ...bPreview.missingItems[0].ref, contentHash: '0'.repeat(64) }
  assert.match(await evaluate(`window.scry.conversations.readItem(${json(id)},${json(forgedRef)}).then(()=>null,error=>String(error))`), /不属于当前对话/)
  assert.match(await evaluate(`window.scry.conversations.readItem(${json(id)},${json({ ...bPreview.missingItems[0].ref, path: '/etc/passwd' })}).then(()=>null,error=>String(error))`), /格式或字段/)
  assert.equal(inputs(fixture).length, 1, 'reading preview bodies must not invoke a Provider')
  await confirm(true)
  const second = await settled(evaluate, id, 2)
  assert.equal(second.turns[1].providerId, 'codex')
  assert.equal(readFileSync(join(fixture.workspace, 'remote-second.txt'), 'utf8'), 'remote-second.txt\n')

  const atLatest = `(() => { const el=document.querySelector('.conversation-chat .chat'); return el && el.scrollHeight-el.clientHeight-el.scrollTop < 2 })()`
  await wait(() => evaluate(`document.querySelectorAll('.conversation-chat .turn').length === 2 && ${atLatest}`), 'new output follows the transcript bottom')
  // The bottom-follow policy includes 32px of slack. The original viewport only
  // overflowed by 13px, so its top was still inside that zone, not older output.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false })
  try {
    await wait(() => evaluate(`${atLatest} && (() => { const el=document.querySelector('.conversation-chat .chat'); return el.scrollHeight-el.clientHeight > 32 })()`), 'scrollable transcript follows the bottom')
    const wheelPoint = await evaluate(`(() => {const rect=document.querySelector('.conversation-chat .chat').getBoundingClientRect();return {x:rect.left+10,y:rect.top+30}})()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -10000 })
    await wait(() => evaluate(`document.querySelector('.conversation-chat .chat').scrollTop === 0 && !${atLatest}`), 'user scroll leaves bottom following')
    for (const height of [760, 640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height, deviceScaleFactor: 1, mobile: false })
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const position = await evaluate(`(() => { const el=document.querySelector('.conversation-chat .chat'); return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } })()`)
      assert.equal(position.top, 0, `layout changes must preserve the user reading older output: ${JSON.stringify(position)}`)
    }
  } finally { await cdp.send('Emulation.clearDeviceMetricsOverride') }

  const aPreview = await preview(evaluate, id, 'claude')
  assert.equal(aPreview.continuation.kind, 'resume')
  assert.deepEqual(aPreview.missingItems.map((item) => item.ref.runId), [second.turns[1].runId, second.turns[1].runId])
  await compose('desktop remote write three', 'ArrowUp')
  assert.equal(inputs(fixture).length, 2, 'returning to Claude only changes the next destination')
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
  return exerciseUnifiedConversationContinuation({ cdp, evaluate, fixture, click, button, key, wait, read, preview, settled, sendRequest, inputs, ledger, capture, captureNarrow, screenshots, id, bPreview, aPreview, final })

}

export { verifyUnifiedConversationRestart } from './unified-conversation-restart-smoke.mjs'
import { exerciseUnifiedConversationContinuation } from './unified-conversation-continuation-smoke.mjs'
