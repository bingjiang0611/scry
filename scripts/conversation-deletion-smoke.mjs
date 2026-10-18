import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { conversationFixtureArchivePath } from './conversation-ownership-smoke.mjs'

const json = JSON.stringify
const hash = value => createHash('sha256').update(value).digest('hex')

export async function exerciseConversationDeletion({ cdp, evaluate, fixture, click, button, key, wait, read, preview, settled, sendRequest, inputs, ledger, capture, captureNarrow }) {
  const conversation = await evaluate(`window.scry.conversations.create(${json(fixture.workspace)})`)
  const id = conversation.id
  const first = sendRequest(await preview(evaluate, id, 'claude'), 'delete-first-turn', 'desktop remote write one')
  await evaluate(`window.scry.conversations.send(${json(first)})`)
  await settled(evaluate, id, 1)
  const second = sendRequest(await preview(evaluate, id, 'codex'), 'delete-second-turn', 'desktop remote write two')
  await evaluate(`window.scry.conversations.send(${json(second)})`)
  await settled(evaluate, id, 2)
  // Read-only readiness: terminal UI can precede archive/runtime settlement.
  await wait(() => evaluate(`window.scry.conversations.previewDeletion(${json(id)}).then(()=>true,error=>{
    if(String(error).includes('请先存档')) return true;
    if(String(error).includes('运行或证据保存未收敛')) return false;
    throw error;
  })`), 'deletion runtime has really settled')
  const entry = `.sidebar [data-conversation-id=${json(id)}]`
  await wait(() => evaluate(`Boolean(document.querySelector(${json(entry)}))`), 'live deletion target in sidebar')
  await click(entry)
  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId===${json(id)}`), 'deletion target selected before archival')
  await click('[aria-label="存档统一对话"]')
  await wait(() => evaluate(`!document.querySelector(${json(entry)}) && Boolean(document.querySelector('[aria-label="删除统一对话"]'))`), 'archived target stays open but leaves the sidebar')
  const oldPreview = await evaluate(`window.scry.conversations.previewDeletion(${json(id)})`)
  assert.deepEqual(new Set(oldPreview.targets.map(target => target.providerId)), new Set(['claude', 'codex']))
  await evaluate(`window.scry.conversations.update(${json(id)},${oldPreview.revision},{kind:'rename',title:'Delete isolated copies'})`)
  assert.match(await evaluate(`window.scry.conversations.delete(${json(id)},${json(oldPreview.fingerprint)}).then(()=>'',error=>String(error))`), /删除范围已变化/)
  assert.equal(ledger(fixture, id).deletion, undefined)

  await wait(() => evaluate(`document.querySelector('.unified-conversation')?.dataset.conversationId===${json(id)} && Boolean(document.querySelector('[aria-label="删除统一对话"]'))`), 'archived deletion view')
  const original = ledger(fixture, id)
  const archives = original.turns.map(turn => conversationFixtureArchivePath(fixture.userData, fixture.workspace, turn.archive.sessionId,
    turn.archive.providerTurnId, original.bindings.find(binding => binding.id === turn.bindingId).providerId))
  for (const path of archives) assert.ok(existsSync(path), `real archive must exist before deletion: ${path}`)
  const effects = ['remote-first.txt', 'remote-second.txt'].map(file => ({ file, body: readFileSync(join(fixture.workspace, file), 'utf8') }))
  const calls = inputs(fixture)
  const statsBefore = await evaluate('window.scry.stats()')
  assert.equal(statsBefore.status, 'ready')
  await click('[aria-label="删除统一对话"]')
  await wait(() => evaluate("document.querySelector('.unified-delete .danger')?.disabled === false"), 'deletion preview')
  await capture('deletion')
  await captureNarrow('deletion', ['.unified-delete', '.unified-delete .danger', '.unified-delete .unified-actions'])
  await wait(() => evaluate("document.activeElement?.textContent === '取消'"), 'destructive dialog defaults to cancellation')
  await key('Enter', 'Enter', 13)
  await wait(() => evaluate("!document.querySelector('.unified-delete')"), 'cancel without mutation')
  await wait(() => evaluate("document.activeElement === document.querySelector('[aria-label=\"删除统一对话\"]')"), 'cancel restores the delete trigger')
  const archiveBytes = archives.map(path => readFileSync(path))
  for (const binding of original.bindings) {
    assert.match(await evaluate(`window.scry.deleteSession(${json({providerId:binding.providerId,agentProfileId:'different-profile',cwd:fixture.workspace,externalSessionId:binding.nativeSessionId})}).then(()=>'',error=>String(error))`), /归属统一对话/, 'profile spoofing cannot bypass physical archive ownership')
  }
  assert.deepEqual(ledger(fixture, id), original)
  archives.forEach((path, index) => assert.deepEqual(readFileSync(path), archiveBytes[index]))

  const cache = join(fixture.userData, 'conversation-history-v1', hash(JSON.stringify([id, fixture.workspace])))
  const saved = `${cache}-saved-test`
  const outside = join(fixture.workspace, '.scry', 'deletion-preserved')
  mkdirSync(outside, { recursive: true })
  const marker = join(outside, 'marker.txt')
  writeFileSync(marker, 'workspace evidence must survive')
  assert.ok(existsSync(cache), 'the real cross-provider handoff must create a private body')
  renameSync(cache, saved)
  symlinkSync(outside, cache)
  await click('[aria-label="删除统一对话"]')
  await wait(() => evaluate("document.querySelector('.unified-delete .danger')?.disabled === false"), 'partial failure preview ready')
  await button('确认删除 Scry 副本')
  await wait(() => evaluate("document.querySelector('.unified-delete section')?.textContent.includes('未完整删除')"), 'real partial deletion is reported')
  await wait(() => evaluate("document.activeElement?.textContent === '关闭'"), 'partial receipt focuses its enabled close action')
  const page = await read(evaluate, id)
  assert.equal(page.summary.deletion.status, 'pending')
  assert.ok(page.summary.deletion.result.failed.some(failure => failure.store === 'frozen handoff bodies'))
  assert.deepEqual(page.turns, [], 'deleted bodies are unavailable, not replayed from a cache')
  assert.ok(archives.every(path => !existsSync(path)), 'both Providers really lost their owned App archive copies')
  assert.equal(readFileSync(marker, 'utf8'), 'workspace evidence must survive')
  assert.match(await evaluate(`window.scry.conversations.send(${json(first)}).then(()=>'',error=>String(error))`), /正在删除或已删除/)
  assert.match(await evaluate(`window.scry.conversations.update(${json(id)},${page.summary.revision},{kind:'archive',archived:false}).then(()=>'',error=>String(error))`), /正在删除或已删除/)
  assert.match(await evaluate(`window.scry.conversations.delete(${json(id)},${json(oldPreview.fingerprint)}).then(()=>'',error=>String(error))`), /本次请求未执行清理/, 'a stale retry must not claim that earlier partial effects never happened')
  await capture('deletion-partial')
  await button('关闭')
  await wait(() => evaluate("document.activeElement?.textContent === '刷新状态'"), 'partial result returns focus to status refresh')
  unlinkSync(cache)
  renameSync(saved, cache)
  await wait(() => evaluate("document.querySelector('[aria-label=\"删除统一对话\"]')?.textContent==='继续清理…'"), 'partial deletion keeps a retry entry')
  await click('[aria-label="删除统一对话"]')
  await wait(() => evaluate("document.querySelector('.unified-delete .danger')?.disabled === false"), 'explicit retry preview')
  await button('确认删除 Scry 副本')
  await wait(() => evaluate("document.querySelector('.unified-delete section')?.textContent.includes('逻辑入口已删除')"), 'local cleanup finishes')
  await wait(() => evaluate("document.activeElement?.textContent === '关闭'"), 'successful receipt focuses its enabled close action')
  const completed = ledger(fixture, id)
  assert.equal(completed.deletion.status, 'complete')
  const statsAfter = await evaluate('window.scry.stats()')
  assert.equal(statsAfter.status, 'ready')
  assert.equal(statsAfter.totals.turns, statsBefore.totals.turns - 2, 'SQLite really removes only the two deleted runs')
  assert.ok(!existsSync(cache))
  assert.equal(readFileSync(marker, 'utf8'), 'workspace evidence must survive')
  for (const effect of effects) assert.equal(readFileSync(join(fixture.workspace, effect.file), 'utf8'), effect.body)
  for (const binding of original.bindings) {
    assert.match(await evaluate(`window.scry.deleteSession(${json({providerId:binding.providerId,cwd:fixture.workspace,externalSessionId:binding.nativeSessionId,conversationId:id})}).then(()=>'',error=>String(error))`), /归属统一对话/, 'untrusted extra fields cannot select the internal owned-delete authority')
  }
  assert.deepEqual(await evaluate(`window.scry.conversations.delete(${json(id)},${json(completed.deletion.fingerprint)})`), completed.deletion.result)
  assert.deepEqual(inputs(fixture), calls, 'deletion/cancellation/partial retry/duplicate never invoke a Provider')
  await button('关闭')
  await wait(() => evaluate(`!document.querySelector(${json(entry)})`), 'completed tombstone is hidden from the catalog')
  await wait(() => evaluate("document.activeElement?.textContent === '刷新状态'"), 'deleted trigger has a stable keyboard successor')
  const catalog = (await evaluate('window.scry.listProjects()')).find(project => project.cwd === fixture.workspace)
  assert.ok(catalog.sessions.every(session => !original.bindings.some(binding => binding.nativeSessionId === session.externalSessionId)))
  return { id, fingerprint: completed.deletion.fingerprint, receipt: completed.deletion.result, first, marker, archives }
}

export async function verifyConversationDeletionRestart(evaluate, fixture, result, inputs) {
  const before = inputs(fixture)
  const page = await evaluate(`window.scry.conversations.read(${json(result.id)})`)
  assert.equal(page.summary.deletion.status, 'complete')
  assert.deepEqual(page.turns, [])
  assert.deepEqual(await evaluate(`window.scry.conversations.delete(${json(result.id)},${json(result.fingerprint)})`), result.receipt)
  assert.match(await evaluate(`window.scry.conversations.send(${json(result.first)}).then(()=>'',error=>String(error))`), /正在删除或已删除/)
  assert.equal(readFileSync(result.marker, 'utf8'), 'workspace evidence must survive')
  assert.ok(result.archives.every(path => !existsSync(path)))
  assert.deepEqual(inputs(fixture), before)
}
