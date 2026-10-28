import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { json, wait, inputs, preview, settled } from './conversation-smoke-driver.mjs'

export async function exerciseConversationHandoff({ cdp, evaluate, fixture, click, button, key, selectAgent, compose, confirm }) {
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
  await click('.sb-view-tabs [role="tab"]:last-child')
  await wait(() => evaluate(`document.querySelector('.sb-activity [data-conversation-id="${id}"]')?.closest('[data-activity-group]')?.dataset.activityGroup === 'completed'`), 'real logical result appears in completed')
  await click('.sb-view-tabs [role="tab"]:first-child')
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
  return { id, aPreview, bPreview, atLatest }
}
