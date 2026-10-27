import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const json = JSON.stringify

// Production App/IPC routing with a synthetic Pi profile. Exact Pi RPC/file
// receipts are separately exercised by providers/pi.test.ts; no real account.
export async function exercisePiAgentSwitch({ cdp, evaluate, fixture, click, wait, inputs, read, settled, ledger }) {
  const profile = 'pi:0123456789abcdef'
  const sourceContext = { providerId: 'pi', agentProfileId: profile, cwd: fixture.workspace }
  await evaluate(`window.scry.newSession(${json(sourceContext)})`)
  const started = await evaluate(`window.scry.start(${json({ ...sourceContext, expectedExternalSessionId: null, permissionMode: 'full_access', prompt: 'desktop remote pi source' })})`)
  await wait(() => evaluate(`window.scry.activeRuns().then(runs=>!runs.some(run=>run.runId===${json(started.runId)}))`), 'Pi source settles')
  const source = { ...sourceContext, externalSessionId: inputs(fixture).at(-1).sessionId }
  await wait(() => evaluate(`window.scry.conversations.previewAdoption(${json(source)}).catch(error=>{if(String(error).includes('源 Provider 仍在执行'))return false;throw error})`), 'Pi source archive settles')
  assert.match(await evaluate(`window.scry.conversations.previewAdoption(${json(source)}, {providerId:'qoder'}).then(()=>'',error=>String(error))`), /不受支持/)
  assert.match(await evaluate(`window.scry.conversations.previewAdoption(${json({ ...source, agentProfileId: 'pi:fedcba9876543210' })}).then(()=>'',error=>String(error))`), /不属于已登记/)
  await wait(() => evaluate("Boolean(document.querySelector('.sidebar .sb-sess[data-provider=\"pi\"]'))"), 'Pi source remains selectable after rejected preflight')
  await click('.sidebar .sb-sess[data-provider="pi"]')
  await wait(() => evaluate(`document.querySelector('.clibtn')?.dataset.agentId === ${json(profile)} && document.querySelector('.clibtn')?.disabled === false`), 'Pi profile unlocked in normal composer')
  await click('textarea[aria-label="描述任务"]')
  await cdp.send('Input.insertText', { text: 'desktop remote from Pi to Claude' })
  const count = inputs(fixture).length
  await click('.clibtn')
  await click('.climenu .mitem[data-agent-id="claude"]')
  const id = await wait(() => evaluate("document.querySelector('.conversation-chat')?.dataset.conversationId"), 'Pi history adopted by Agent picker')
  assert.equal(inputs(fixture).length, count, 'switching Pi does not execute a Provider')
  assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"描述任务\"]').value"), 'desktop remote from Pi to Claude')
  const imported = await read(evaluate, id)
  assert.equal(imported.bindings[0].agentProfileId, profile)
  assert.equal(imported.turns[0].runId, started.runId)
  const send = async total => {
    await wait(() => evaluate("document.querySelector('.conversation-chat .send')?.disabled === false"), 'switched composer ready')
    await click('.conversation-chat .send')
    return settled(evaluate, id, total)
  }
  await send(2)
  for (const [agentId, prompt, total] of [
    [profile, 'desktop remote back to Pi', 3],
    ['claude', 'desktop remote return to Claude', 4],
    [profile, 'desktop remote resume Pi', 5]
  ]) {
    await wait(() => evaluate("document.querySelector('.clibtn')?.disabled === false"), 'previous run leaves Agent picker unlocked')
    const before = inputs(fixture).length
    await click('.clibtn')
    await click(`.climenu .mitem[data-agent-id=${json(agentId)}]`)
    await wait(() => evaluate(`document.querySelector('.clibtn')?.dataset.agentId === ${json(agentId)}`), 'selected profile retained')
    assert.equal(inputs(fixture).length, before)
    if (agentId === profile) {
      await click('.permission-mode-trigger')
      await wait(() => evaluate("Boolean(document.querySelector('.permission-mode-option.is-danger'))"), 'Pi full-access choice available')
      await click('.permission-mode-option.is-danger')
    }
    await click('textarea[aria-label="描述任务"]')
    await cdp.send('Input.insertText', { text: prompt })
    await send(total)
  }
  const page = await read(evaluate, id)
  const calls = inputs(fixture).filter(call => page.turns.some(turn => turn.runId === call.runId))
  assert.deepEqual(calls.map(call => call.providerId), ['pi', 'claude', 'pi', 'claude', 'pi'])
  assert.equal(calls[2].resume, null, 'unverified legacy Pi history is not claimed as compatible')
  assert.equal(calls[3].resume, calls[1].sessionId)
  assert.equal(calls[4].resume, calls[2].sessionId, 'managed Pi context survives A→B→A')
  assert.equal(calls[4].agentProfileId, profile)
  const diagnosticPath = join(fixture.userData, 'pi-run-diagnostics.json')
  const piRunIds = calls.filter(call => call.providerId === 'pi').map(call => call.runId)
  const diagnostics = await wait(() => {
    if (!existsSync(diagnosticPath)) return false
    const snapshot = JSON.parse(readFileSync(diagnosticPath, 'utf8'))
    return piRunIds.every(runId => snapshot.runs.some(run =>
      run.runId === runId && run.phase === 'main_settled' && run.mainDone && run.mainSettled)) && snapshot
  }, 'Pi diagnostic snapshots follow production main settlement')
  assert.equal(diagnostics.coverage, 'partial')
  for (const runId of piRunIds) {
    const phases = diagnostics.runs.find(run => run.runId === runId).history.map(entry => entry.phase)
    assert.ok(phases.includes('main_finalization'))
    assert.ok(phases.includes('main_settlement'))
  }
  assert.ok(!JSON.stringify(diagnostics).includes('desktop remote pi source'))
  assert.ok(!JSON.stringify(diagnostics).includes(fixture.workspace))
  assert.deepEqual(ledger(fixture, id).turns[4].importedItems.map(item => item.runId), [page.turns[3].runId, page.turns[3].runId])
  return { id, profile, calls: calls.length, runIds: page.turns.map(turn => turn.runId) }
}

// Synthetic clipboard data drives the production paste handler; send/Agent
// controls use real CDP coordinate input. Provider execution stays smoke-only.
export async function exerciseConversationImages({ cdp, evaluate, fixture, click, wait, inputs, read, preview, settled, sendRequest, capture }) {
  const image = readFileSync(new URL('../build/icon.png', import.meta.url))
  const contentHash = createHash('sha256').update(image).digest('hex')
  const open = async id => {
    const entry = `.sidebar [data-conversation-id=${json(id)}]`
    await wait(() => evaluate(`Boolean(document.querySelector(${json(entry)}))`), 'image conversation in sidebar')
    await click(entry)
    await wait(() => evaluate(`document.querySelector('.conversation-chat')?.dataset.conversationId === ${json(id)} && document.querySelector('.clibtn')?.disabled === false`), 'image composer ready')
  }
  const agent = async id => {
    if (await evaluate(`document.querySelector('.clibtn')?.dataset.agentId !== ${json(id)}`)) {
      await click('.clibtn'); await click(`.climenu .mitem[data-agent-id=${json(id)}]`)
    }
    await wait(() => evaluate(`document.querySelector('.clibtn')?.dataset.agentId === ${json(id)} && document.querySelector('.clibtn')?.disabled === false`), 'image target selected')
  }
  const paste = async () => {
    await click('textarea[aria-label="描述任务"]')
    await evaluate(`(() => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(atob(${json(image.toString('base64'))}), c => c.charCodeAt(0))], 'current.png', {type:'image/png'}))
      document.querySelector('textarea[aria-label="描述任务"]').dispatchEvent(new ClipboardEvent('paste', {clipboardData:data,bubbles:true,cancelable:true}))
    })()`)
    await wait(() => evaluate("document.querySelectorAll('.draft-attachment').length === 1 && document.querySelector('.draft-attachment img')?.naturalWidth > 0"), 'pasted image decodes in ordinary composer')
  }
  const created = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  await open(created.id); await agent('codex'); await paste()
  await capture('current-image')
  assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="描述任务"]\').value'), '')
  await wait(() => evaluate("document.querySelector('.conversation-chat .send')?.disabled === false"), 'image-only send enabled')
  await click('.conversation-chat .send')
  const first = await settled(evaluate, created.id, 1)
  const imageCall = inputs(fixture).find(call => call.runId === first.turns[0].runId)
  assert.equal(imageCall.attachments.length, 1)
  assert.equal(imageCall.attachments[0].contentHash, contentHash)
  assert.equal(createHash('sha256').update(readFileSync(imageCall.attachments[0].path)).digest('hex'), contentHash)
  await wait(() => evaluate("document.querySelectorAll('.draft-attachment').length === 0"), 'submitted image removed from draft')
  await agent('claude')
  await click('textarea[aria-label="描述任务"]')
  await cdp.send('Input.insertText', { text: '  follow up without an image\n\n' })
  await wait(() => evaluate("document.querySelector('.conversation-chat .send')?.disabled === false"), 'text-only handoff enabled')
  await click('.conversation-chat .send')
  const second = await settled(evaluate, created.id, 2)
  const textCall = inputs(fixture).find(call => call.runId === second.turns[1].runId)
  assert.equal(textCall.prompt, '  follow up without an image\n\n')
  assert.equal(textCall.attachments, undefined, 'historical images are not sent again')
  assert.ok(!textCall.historicalContext.text.includes('Scry pasted image attachments:'), 'historical attachment hints are not replayed')

  const failed = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  const longHistory = 'desktop remote ' + 'complete historical text '.repeat(1800)
  const source = sendRequest(await preview(evaluate, failed.id, 'claude'), 'image-source', longHistory)
  await evaluate(`window.scry.conversations.send(${json(source)})`)
  await settled(evaluate, failed.id, 1)
  await open(failed.id); await agent('codex'); await paste()
  await cdp.send('Input.insertText', { text: 'retain this draft' })
  const before = inputs(fixture).length
  await click('.conversation-chat .send')
  await wait(() => evaluate("document.querySelector('.composer-status.is-error')?.textContent.includes('历史检索工具')"), 'unavailable reader refuses before native input')
  assert.equal(inputs(fixture).length, before)
  assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="描述任务"]\').value'), 'retain this draft')
  assert.equal(await evaluate("document.querySelectorAll('.draft-attachment').length"), 1)
  assert.equal((await read(evaluate, failed.id)).turns.length, 1, 'failed admission did not add a native turn')
  return { id: created.id, failedId: failed.id, contentHash, runIds: second.turns.map(turn => turn.runId) }
}
