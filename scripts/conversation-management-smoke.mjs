import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { conversationFixtureArchivePath } from './conversation-ownership-smoke.mjs'

const json = JSON.stringify

// Native Chromium input against the production App/IPC, using only the caller's
// isolated userData/workspace and synthetic Provider. No credential discovery.
export async function exerciseConversationManagement({ cdp, evaluate, fixture, id, click, button, key, wait, read, inputs, ledger, capture, captureNarrow }) {
  const original = ledger(fixture, id)
  const before = inputs(fixture)
  await click('[aria-label="重命名统一对话"]')
  await wait(() => evaluate("document.activeElement === document.querySelector('.session-rename-dialog input')"), 'rename dialog autofocus')
  await cdp.send('Input.insertText', { text: 'Managed logical conversation' })
  assert.equal(await evaluate("document.querySelector('.session-rename-dialog input').value"), 'Managed logical conversation')
  await key('Enter', 'Enter', 13)
  await wait(() => evaluate("!document.querySelector('.session-rename-dialog') && document.querySelector('.unified-header h1')?.textContent === 'Managed logical conversation'"), 'renamed logical title')
  await click('[aria-label="置顶统一对话"]')
  await wait(() => evaluate(`Boolean(document.querySelector('.sb-pinned [data-conversation-id="${id}"]'))`), 'logical conversation moves into global pins')
  await click('textarea[aria-label="统一对话消息"]')
  await cdp.send('Input.insertText', { text: 'draft retained across archival' })
  await click('[aria-label="存档统一对话"]')
  await wait(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"统一对话消息\"]')?.disabled && document.querySelector('[aria-label=\"恢复统一对话\"]'))"), 'archived conversation is read only')
  assert.equal(await evaluate(`Boolean(document.querySelector('.sb-pinned [data-conversation-id="${id}"]'))`), false)
  await wait(() => evaluate(`Boolean(document.querySelector('.unified-archived [data-conversation-id="${id}"]'))`), 'archived entry is reachable')
  assert.equal(await evaluate(`window.scry.conversations.preview(${json(id)}, {providerId:'claude'}).then(()=>false,()=>true)`), true)
  await captureNarrow('archived')
  await click('[aria-label="恢复统一对话"]')
  await wait(() => evaluate("!document.querySelector('textarea[aria-label=\"统一对话消息\"]')?.disabled"), 'restored conversation is editable')
  assert.equal(await evaluate("document.querySelector('textarea[aria-label=\"统一对话消息\"]').value"), 'draft retained across archival')
  assert.deepEqual(ledger(fixture, id).turns, original.turns)
  assert.deepEqual(ledger(fixture, id).bindings, original.bindings)
  assert.deepEqual(inputs(fixture), before, 'metadata changes must not execute a Provider or add usage')

  // A real legacy run produces the migration source, not a manually invented ledger.
  await evaluate(`window.scry.newSession({providerId:'codex',cwd:${json(fixture.workspace)}})`)
  const started = await evaluate(`window.scry.start({providerId:'codex',cwd:${json(fixture.workspace)},expectedExternalSessionId:null,prompt:'desktop remote write one'})`)
  await wait(() => evaluate(`window.scry.activeRuns().then(runs=>!runs.some(run=>run.runId===${json(started.runId)}))`), 'legacy source has settled')
  const receipt = inputs(fixture).at(-1)
  assert.equal(receipt.runId, started.runId)
  const source = { providerId: 'codex', cwd: fixture.workspace, externalSessionId: receipt.sessionId }
  const sourcePreview = await wait(() => evaluate(`window.scry.conversations.previewAdoption(${json(source)}).catch(error=>{
    if (String(error).includes('源 Provider 仍在执行、保存证据或删除')) return false;
    throw error;
  })`), 'legacy archive and runtime settlement, not just terminal UI')
  const path = conversationFixtureArchivePath(fixture.userData, fixture.workspace, receipt.sessionId, `${started.runId}:provider-turn`)
  const bytes = readFileSync(path)
  try {
    const changed = JSON.parse(bytes.toString())
    changed.turns[0].userText += ' changed after preview'
    writeFileSync(path, JSON.stringify(changed))
    assert.match(await evaluate(`window.scry.conversations.adopt(${json(source)},${json(sourcePreview.fingerprint)}).then(()=>'',error=>String(error))`), /迁移源已变化/)
    assert.ok((await evaluate('window.scry.listProjects()')).find(project => project.cwd === fixture.workspace).sessions.some(session => session.externalSessionId === receipt.sessionId), 'failed adoption retains the old entry')
  } finally { writeFileSync(path, bytes) }
  const invocations = inputs(fixture)
  const usageBefore = (await evaluate('window.scry.stats()')).totals
  const menu = 'button[aria-label="会话操作：desktop remote write one"]'
  await wait(() => evaluate(`Boolean(document.querySelector(${json(menu)}))`), 'legacy source menu')
  const openMenu = async () => {
    const point = await evaluate(`(() => { const row=document.querySelector(${json(menu)}).closest('.sb-sess-row');row.scrollIntoView({block:'nearest'});const rect=row.getBoundingClientRect();return {x:rect.left+12,y:rect.top+rect.height/2} })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await wait(() => evaluate(`(() => { const node=document.querySelector(${json(menu)});const rect=node.getBoundingClientRect();return node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)) })()`), 'hover reveals native session actions')
    await click(menu)
  }
  await openMenu()
  await key('ArrowDown', 'ArrowDown', 40)
  assert.equal(await evaluate("document.activeElement?.textContent.trim()"), '迁入已捕获历史…')
  await key('Enter', 'Enter', 13)
  await wait(() => evaluate("document.querySelector('.unified-adoption .btn.primary')?.disabled === false"), 'source preview rendered')
  await capture('adoption')
  await captureNarrow('adoption', ['.unified-adoption', '.unified-adoption .btn.primary', '.unified-adoption .unified-actions'])
  await key('Escape', 'Escape', 27)
  await wait(() => evaluate("!document.querySelector('.unified-adoption')"), 'migration cancellation')
  assert.deepEqual(inputs(fixture), invocations)
  await openMenu()
  await button('迁入已捕获历史…')
  await wait(() => evaluate("document.querySelector('.unified-adoption .btn.primary')?.disabled === false"), 'source confirmation ready')
  await button('确认迁入，不发送')
  const adoptedId = await wait(() => evaluate(`(() => {const el=document.querySelector('.unified-conversation');return el?.dataset.conversationId && el.dataset.conversationId !== ${json(id)} ? el.dataset.conversationId : false})()`), 'migration selects stable logical entry')
  const adopted = await read(evaluate, adoptedId)
  assert.equal(adopted.turns.length, 1)
  assert.equal(adopted.turns[0].delivery.status, 'imported')
  assert.equal(adopted.turns[0].runId, started.runId)
  assert.ok(adopted.bindings[0].retiredReason)
  assert.deepEqual(ledger(fixture, adoptedId).turns[0].nativeItems, [])
  assert.deepEqual(readFileSync(path), bytes, 'migration leaves the source archive intact')
  const next = await evaluate(`window.scry.conversations.preview(${json(adoptedId)}, {providerId:'codex'})`)
  assert.equal(next.continuation.kind, 'fresh', 'unproven legacy identity must not resume a native session')
  assert.equal(next.missingItems.length, 2)
  assert.equal((await evaluate(`window.scry.conversations.adopt(${json(source)},${json(sourcePreview.fingerprint)})`)).id, adoptedId, 'same fingerprint retries reuse durable ownership')
  const projects = await evaluate('window.scry.listProjects()')
  assert.ok(!projects.find(project => project.cwd === fixture.workspace).sessions.some(session => session.externalSessionId === receipt.sessionId))
  for (const alias of [receipt.sessionId, started.runId]) {
    const ref = { ...source, externalSessionId: alias }
    for (const operation of [`window.scry.renameSession(${json(ref)},'must not rename')`, `window.scry.deleteSession(${json(ref)})`]) {
      assert.match(await evaluate(`${operation}.then(()=>'',error=>String(error))`), /归属统一对话/)
    }
  }
  assert.deepEqual(inputs(fixture), invocations, 'preview, migration, duplicate and blocked legacy writes never execute a Provider')
  assert.deepEqual((await evaluate('window.scry.stats()')).totals, usageBefore, 'migration does not double count existing SQLite usage')
  await capture('adopted')
  await wait(() => evaluate(`document.querySelector('input[aria-label="Codex 默认配置"]')?.checked`), 'migrated provider selected')
  await click('textarea[aria-label="统一对话消息"]')
  await cdp.send('Input.insertText', { text: 'desktop remote write two' })
  await button('预览并发送')
  await wait(() => evaluate("Boolean(document.querySelector('.unified-preview fieldset > label input[type=\"checkbox\"]'))"), 'migration continuation requires explicit fresh context')
  await click('.unified-preview fieldset > label input[type="checkbox"]')
  await button('确认发送')
  const continued = await wait(async () => {
    const page = await read(evaluate, adoptedId)
    return page.turns.length === 2 && !page.summary.activeRunId && page.turns[1].delivery.status === 'accepted' ? page : false
  }, 'migrated conversation continues on the real managed entry')
  assert.equal(continued.bindings.length, 2)
  const newNativeId = continued.bindings[1].nativeSessionId
  assert.notEqual(newNativeId, receipt.sessionId)
  assert.equal(inputs(fixture).length, invocations.length + 1)
  assert.equal(inputs(fixture).at(-1).resume, null)
  assert.deepEqual(ledger(fixture, adoptedId).turns[1].importedItems, next.missingItems.map(item => item.ref))
  assert.match(await evaluate(`window.scry.conversations.adopt(${json({ ...source, externalSessionId: newNativeId })},${json(sourcePreview.fingerprint)}).then(()=>'',error=>String(error))`), /已归属统一对话/, 'a migration fingerprint cannot be replayed against a different native binding')
  return { id: adoptedId, source, fingerprint: sourcePreview.fingerprint, runId: started.runId, nextRunId: continued.turns[1].runId, originalTitle: 'Managed logical conversation' }
}
