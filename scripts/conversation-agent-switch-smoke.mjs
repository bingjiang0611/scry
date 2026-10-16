import assert from 'node:assert/strict'

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
  assert.deepEqual(ledger(fixture, id).turns[4].importedItems.map(item => item.runId), [page.turns[3].runId, page.turns[3].runId])
  return { id, profile, calls: calls.length, runIds: page.turns.map(turn => turn.runId) }
}
