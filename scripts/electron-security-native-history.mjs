import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exerciseActivityHistory } from './electron-security-activity-history.mjs'

export async function exerciseNativeHistory(smokeContext) {
  const { evaluate, cdp, canonicalWorkspace, home, userDataDir, nativeHistoryPerformanceOnly, nativeSessionId } = smokeContext

    const wait = expression => evaluate(`(async () => {
      const deadline = performance.now() + 10000;
      while (!(${expression})) {
        if (performance.now() > deadline) throw new Error('Native history UI timed out: ' + ${JSON.stringify(expression)});
        await new Promise(requestAnimationFrame);
      }
    })()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('手机会话恢复测试'))`)
    const point = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('手机会话恢复测试'));
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Session row obscured');
      return { x, y };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await wait(`document.body.textContent.includes('主机重启前已有的原生回复')`)
    const text = await evaluate('document.body.textContent')
    assert.ok(text.includes('手机发起的真实格式消息'))
    assert.ok(text.includes('Pi 原生会话记录'))
    assert.ok(!text.includes('abandoned branch must not appear'))
    assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])
    if (!nativeHistoryPerformanceOnly) await exerciseActivityHistory(smokeContext)
    // Continue/reopen after one canonical archived turn is added. The original
    // native-only prefix must survive, and a requested page limit must be real.
    const nativePath = join(home, '.pi', 'agent', 'sessions', `--${canonicalWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, `2026-10-13_${nativeSessionId}.jsonl`)
    const entries = []
    let parentId = 'a'
    const continuedTurns = nativeHistoryPerformanceOnly ? 4000 : 40
    for (let i = 0; i < continuedTurns; i++) {
      entries.push({ type: 'message', id: `continued-user-${i}`, parentId, timestamp: '2026-10-13T05:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: `continued prompt ${i}` }] } })
      parentId = `continued-reply-${i}`
      entries.push({ type: 'message', id: parentId, parentId: `continued-user-${i}`, timestamp: '2026-10-13T05:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: nativeHistoryPerformanceOnly ? `${'reply'.repeat(410)}-${i}` : `continued reply ${i}` }] } })
    }
    appendFileSync(nativePath, '\n' + entries.map(entry => JSON.stringify(entry)).join('\n'))
    const context = { providerId: 'pi', agentProfileId: 'pi:rotom', cwd: canonicalWorkspace, externalSessionId: nativeSessionId }
    if (nativeHistoryPerformanceOnly) {
      const hash = value => createHash('sha256').update(value).digest('hex')
      const dir = join(userDataDir, 'trace-archive-turns-v1', 'pi', `cwd-${hash(canonicalWorkspace)}`, `sid-${hash(nativeSessionId)}`)
      mkdirSync(dir, { recursive: true })
      for (let i = 0; i < continuedTurns; i++) {
        const runId = `ipc-perf-${i}`
        const providerTurnId = `continued-user-${i}`
        writeFileSync(join(dir, `turn-${hash(`provider\0${providerTurnId}`)}.json`), JSON.stringify({
          version: 3, cwd: canonicalWorkspace, sessionId: nativeSessionId, providerId: 'pi', runtimeProvider: 'pi_rpc',
          turns: [{ runId, providerTurnId, userText: `continued prompt ${i}`, done: true, status: 'completed', ts: i + 1,
            items: [{ id: `text-${i}`, runId, kind: 'model', stage: 'text', text: `${'reply'.repeat(410)}-${i}`, ts: '2026-10-13T05:00:01Z' }] }]
        }))
      }
      const samples = []
      for (let repeat = 0; repeat < 4; repeat++) {
        const sample = await evaluate(`(async () => {
          const started = performance.now();
          const latest = await window.scry.loadSession(${JSON.stringify(context)}, { limit: 40 });
          const latestAt = performance.now();
          const older = await window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: latest.offset, limit: 40 });
          return { latestMs: latestAt - started, olderMs: performance.now() - latestAt,
            totalMs: performance.now() - started, totalTurns: latest.totalTurns,
            latestOffset: latest.offset, olderOffset: older.offset,
            selected: [...latest.turns, ...older.turns].map(turn => [turn.runId, turn.userText,
              turn.items.filter(item => item.kind === 'model').map(item => item.text)]) };
        })()`)
        assert.equal(sample.totalTurns, continuedTurns + 1)
        assert.equal(sample.selected.length, 80)
        assert.equal(sample.olderOffset, sample.latestOffset - 40)
        assert.equal(sample.selected.at(-1)[0], 'ipc-perf-3959')
        const selectedPayloadSha256 = hash(JSON.stringify(sample.selected))
        const { selected: _selected, ...metrics } = sample
        samples.push({ ...metrics, repeat, phase: repeat === 0 ? 'first-open-after-bulk-append' : 'unchanged-warm', selectedPayloadSha256 })
      }
      assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])
      console.log(JSON.stringify({ test: 'Pi whole production history IPC', canonicalTurns: continuedTurns,
        nativeTurns: continuedTurns + 1, pageSize: 40, pagesPerSample: 2, samples, noProviderRuns: true }))
      cdp.close()
      return
    }
    const page = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 3 })`)
    assert.equal(page.totalTurns, 41)
    assert.equal(page.offset, 38)
    assert.equal(page.turns.length, 3)
    assert.equal(page.hasOlder, true)
    const hash = value => createHash('sha256').update(value).digest('hex')
    const archiveDir = join(userDataDir, 'trace-archives-v2', 'pi', `cwd-${hash(canonicalWorkspace)}`)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, `sid-${hash(nativeSessionId)}.json`), JSON.stringify({ version: 3,
      providerId: 'pi', runtimeProvider: 'pi_rpc', cwd: canonicalWorkspace, sessionId: nativeSessionId,
      turns: [{ runId: 'scry-continuation', providerTurnId: 'continued-user-39', userText: 'continued prompt 39',
        done: true, status: 'completed', ts: Date.now(), items: [{ id: 'canonical', runId: 'scry-continuation',
          kind: 'model', stage: 'text', text: 'continued reply 39', ts: '2026-10-13T05:00:01Z' },
        { id: 'canonical-result', runId: 'scry-continuation', kind: 'harness', stage: 'result', upstreamProvider: 'qoder',
          tokensIn: 100, cacheReadTokens: 300, cacheCreationTokens: 0, ts: '2026-10-13T05:00:01Z' }] }]
    }))
    const reopened = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 3 })`)
    assert.equal(reopened.totalTurns, 41)
    assert.equal(reopened.turns.length, 3)
    assert.equal(reopened.turns.at(-1).runId, 'scry-continuation')
    const creditOf = turn => turn.items.filter(item => item.stage === 'credit_usage').at(-1)?.creditUsage
    // Keep the existing >64 MiB workload intact: metering is explicitly unavailable beyond its budget.
    assert.equal(creditOf(reopened.turns.at(-1)).status, 'unavailable')
    assert.match(creditOf(reopened.turns.at(-1)).omissionReason, /byte budget/)
    assert.ok(!reopened.turns.some(turn => turn.errorHint?.includes('Pi 原生历史未能核对')))
    const oldest = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 1, limit: 1 })`)
    assert.equal(oldest.turns.length, 1)
    assert.equal(oldest.turns[0].userText, '手机发起的真实格式消息')
    // Separate small session: never shrink the existing >64 MiB history workload for metering.
    const creditSessionId = '11111111-1111-4111-8111-111111111111'
    const creditContext = { ...context, externalSessionId: creditSessionId }
    const creditNativePath = nativePath.replace(`2026-10-13_${nativeSessionId}`, `2026-10-13_${creditSessionId}`)
    writeFileSync(creditNativePath, [
      { type: 'session', version: 3, id: creditSessionId, cwd: canonicalWorkspace },
      { type: 'message', id: 'credit-user', parentId: null, message: { role: 'user', content: 'credit history' } },
      { type: 'custom', id: 'credit-observation', parentId: 'credit-user', customType: 'qoder-credit-observation-v1',
        data: { version: 1, sessionId: creditSessionId, modelId: 'dfmodel', requestId: 'request-1', status: 'reported',
          outcome: 'complete', billable: true, credits: 2.5 } },
      { type: 'message', id: 'credit-reply', parentId: 'credit-observation', message: { role: 'assistant', provider: 'qoder', content: [{ type: 'text', text: 'credit reply' }] } }
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const creditArchiveDir = join(userDataDir, 'trace-archive-turns-v1', 'pi', `cwd-${hash(canonicalWorkspace)}`, `sid-${hash(creditSessionId)}`)
    mkdirSync(creditArchiveDir, { recursive: true })
    writeFileSync(join(creditArchiveDir, `turn-${hash('provider\0credit-user')}.json`), JSON.stringify({
      version: 3, providerId: 'pi', runtimeProvider: 'pi_rpc', cwd: canonicalWorkspace, sessionId: creditSessionId,
      turns: [{ runId: 'credit-run', providerTurnId: 'credit-user', userText: 'credit history', done: true, status: 'completed', ts: Date.now(),
        items: [{ id: 'credit-result', runId: 'credit-run', kind: 'harness', stage: 'result', upstreamProvider: 'qoder', ts: new Date().toISOString() }] }]
    }))
    const creditCatalog = JSON.parse(readFileSync(join(userDataDir, 'app-sessions.json'), 'utf8'))
    creditCatalog.push({ sessionId: creditSessionId, externalSessionId: creditSessionId, runId: 'credit-run', providerId: 'pi',
      agentProfileId: 'pi:rotom', runtimeProvider: 'pi_rpc', cwd: canonicalWorkspace, preview: 'credit history', ts: Date.now() })
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify(creditCatalog))
    const creditHistory = await evaluate(`window.scry.loadSession(${JSON.stringify(creditContext)}, { limit: 1 })`)
    assert.equal(creditOf(creditHistory.turns[0]).value.amount, 2.5, JSON.stringify(creditOf(creditHistory.turns[0])))
    assert.deepEqual(creditOf(creditHistory.turns[0]).source, ['pi_qoder_credit_observation'])
    const creditOlder = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(creditContext)}, { before: 1, limit: 1 })`)
    assert.equal(creditOf(creditOlder.turns[0]).value.amount, 2.5)
    assert.equal(creditOlder.turns[0].items.filter(item => item.stage === 'credit_usage').length, 1)
    const creditTurnPath = join(creditArchiveDir, `turn-${hash('provider\0credit-user')}.json`)
    const creditArchive = JSON.parse(readFileSync(creditTurnPath, 'utf8'))
    creditArchive.turns[0].items.push(creditHistory.turns[0].items.find(item => item.stage === 'credit_usage'))
    writeFileSync(creditTurnPath, JSON.stringify(creditArchive))
    const terminalCredit = await evaluate(`window.scry.turnTerminalEvidence(${JSON.stringify(creditContext)}, 'credit-run')`)
    assert.deepEqual(terminalCredit.map(item => item.stage), ['result', 'credit_usage'])
    assert.equal(terminalCredit.at(-1).creditUsage.value.amount, 2.5)
    const archivePath = join(archiveDir, `sid-${hash(nativeSessionId)}.json`)
    const mixedArchive = JSON.parse(readFileSync(archivePath, 'utf8'))
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a46kAAAAASUVORK5CYII='
    mixedArchive.turns.push({ runId: 'archive-only-early', userText: 'older interrupted attempt',
      done: true, status: 'interrupted', ts: Date.parse('2026-10-13T03:00:00Z'),
      attachments: [{ storage: 'inline', kind: 'image', name: 'older.png', mimeType: 'image/png', dataBase64: png }],
      items: [{ id: 'older-tool', runId: 'archive-only-early', kind: 'tool', stage: 'tool_result', tool: 'bash',
        toolUseId: 'older-call', output: 'canonical older tool output', ts: '2026-10-13T03:00:01Z' },
      { id: 'older-result', runId: 'archive-only-early', kind: 'harness', stage: 'result', tokensIn: 73, tokensOut: 17,
        ts: '2026-10-13T03:00:02Z' }] },
    { runId: 'archive-only-middle', userText: 'interleaved canonical attempt', done: true, status: 'interrupted',
      ts: Date.parse('2026-10-13T04:50:00Z'), items: [{ id: 'middle-text', runId: 'archive-only-middle',
        kind: 'model', stage: 'text', text: 'canonical middle payload', ts: '2026-10-13T04:50:01Z' }] })
    writeFileSync(archivePath, JSON.stringify(mixedArchive))
    // Unlinked attempts precede their next exact native archive anchor. Timestamps alone
    // do not reorder native ancestry or establish attempt ownership.
    const mixed = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 1 })`)
    assert.equal(mixed.totalTurns, 43)
    const middle = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 42, limit: 1 })`)
    assert.equal(middle.offset, 41)
    assert.equal(middle.totalTurns, 43)
    assert.equal(middle.turns[0].runId, 'archive-only-middle')
    assert.ok(middle.turns[0].items.some(item => item.text === 'canonical middle payload'))
    const early = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 41, limit: 1 })`)
    assert.equal(early.offset, 40)
    assert.equal(early.hasOlder, true)
    assert.equal(early.turns[0].runId, 'archive-only-early')
    assert.ok(early.turns[0].items.some(item => item.output === 'canonical older tool output'))
    assert.ok(early.turns[0].items.some(item => item.tokensIn === 73 && item.tokensOut === 17))
    assert.equal(early.turns[0].attachments[0].name, 'older.png')
    assert.equal(early.turns[0].attachments[0].dataBase64, png)
    const segmentDir = join(userDataDir, 'trace-archive-turns-v1', 'pi', `cwd-${hash(canonicalWorkspace)}`, `sid-${hash(nativeSessionId)}`)
    mkdirSync(segmentDir, { recursive: true })
    writeFileSync(join(segmentDir, `turn-${hash('run\0unavailable-attempt')}.json`), '{broken')
    const partial = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 1 })`)
    assert.equal(partial.sourceComplete, false)
    const partialOldest = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 1, limit: 1 })`)
    assert.equal(partialOldest.offset, 0)
    assert.equal(partialOldest.hasOlder, false)
    assert.equal(partialOldest.sourceComplete, false)
    assert.equal(partialOldest.completeness, 'partial')
    const nativeText = readFileSync(nativePath, 'utf8')
    const validReply = JSON.stringify(entries[1])
    assert.ok(nativeText.includes(validReply))
    writeFileSync(nativePath, nativeText.replace(validReply, JSON.stringify({ ...entries[1], timestamp: 'invalid-date' })))
    const stale = await evaluate(`(async () => {
      try { await window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 1, limit: 1 }); return { rejected: false }; }
      catch (error) { return { rejected: true, message: error.message }; }
    })()`)
    assert.equal(stale.rejected, true)
    assert.ok(stale.message.includes('重新打开会话'))
    const fallback = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 43 })`)
    assert.equal(fallback.totalTurns, 3)
    assert.ok(fallback.turns.every(turn => !turn.runId.startsWith('pi-native-')))
    const fallbackOlder = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 1, limit: 1 })`)
    assert.equal(fallbackOlder.totalTurns, 3)
    assert.equal(fallbackOlder.turns[0].runId, 'archive-only-early')
    assert.equal(fallbackOlder.turns[0].attachments[0].dataBase64, png)
    assert.equal(fallbackOlder.sourceComplete, false)
    // Pi and Rotom share native --session history. A launch Profile is not a
    // filter on the session's older turns, including legacy unknown provenance.
    rmSync(nativePath)
    rmSync(archivePath)
    rmSync(segmentDir, { recursive: true })
    mkdirSync(segmentDir, { recursive: true })
    for (let i = 0; i < 55; i++) {
      const runId = `shared-session-${i}`
      const agentProfileId = i < 9 ? undefined : i % 2 ? 'pi:default' : 'pi:rotom'
      writeFileSync(join(segmentDir, `turn-${hash(`run\0${runId}`)}.json`), JSON.stringify({
        version: 3, cwd: canonicalWorkspace, sessionId: nativeSessionId, providerId: 'pi', runtimeProvider: 'pi_rpc',
        turns: [{ runId, agentProfileId, ts: 100 + i, userText: `shared prompt ${i}`, done: true, items: [] }]
      }))
    }
    // Reopen too: the second read exercises the persisted index rather than only its rebuild.
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 40 })`)
      assert.equal(latest.totalTurns, 55)
      assert.equal(latest.turns.length, 40)
      assert.equal(latest.turns[0].runId, 'shared-session-15')
      assert.equal(latest.turns.at(-1).runId, 'shared-session-54')
      assert.equal(latest.sourceComplete, true)
      const older = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 15, limit: 40 })`)
      assert.equal(older.totalTurns, 55)
      assert.deepEqual(older.turns.map(turn => turn.runId), Array.from({ length: 15 }, (_, i) => `shared-session-${i}`))
      assert.equal(older.hasOlder, false)
    }
    const savedTurns = readdirSync(segmentDir).map(file => JSON.parse(readFileSync(join(segmentDir, file), 'utf8')).turns[0])
    assert.equal(savedTurns.filter(turn => !Object.hasOwn(turn, 'agentProfileId')).length, 9, 'history loading must not invent legacy Profile provenance')
    assert.equal(savedTurns.filter(turn => turn.agentProfileId === 'pi:default').length, 23)
    assert.equal(savedTurns.filter(turn => turn.agentProfileId === 'pi:rotom').length, 23)
    assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])
    console.log('Pi native history: real UI/IPC verifies named-Profile native restore, mixed/unknown Profile history, archive-only 55-turn pagination/reopen and unchanged provenance without Provider execution')
    cdp.close()
    return
}
