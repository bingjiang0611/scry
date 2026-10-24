import assert from 'node:assert/strict'

export async function exerciseProviderHistory(smokeContext) {
  const { evaluate, canonicalWorkspace, workspace } = smokeContext
  const lifecycleSmoke = await evaluate(`(async () => {
    const cwd = ${JSON.stringify(canonicalWorkspace)}
    await window.scry.setCwd(cwd)
    let cleanupDone = () => {}
    let cleanupError = () => {}
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake Provider lifecycle timed out')), 15_000)
      cleanupDone = window.scry.onTurnDone((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        resolve({ kind: 'done', event })
      })
      cleanupError = window.scry.onError((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        reject(new Error(event.message))
      })
    })
    const started = await window.scry.start({ providerId: 'codex', cwd, prompt: 'packaged fake-provider smoke' })
    const outcome = await terminal
    const externalSessionId = outcome.event.externalSessionId || outcome.event.sessionId
    const loadedPage = await window.scry.loadSession({ providerId: 'codex', cwd, externalSessionId })
    const loaded = loadedPage?.turns || []
    const toolResult = loaded.flatMap((turn) => turn.items).find((item) => item.stage === 'tool_result')
    const ref = toolResult?.outputContent?.contentRef
    if (!ref || ref.bytes < 12 * 1024 * 1024) throw new Error('large tool body was not persisted')
    const tail = await window.scry.recorderContentPage({ source: 'app-trace', ref, offset: ref.bytes - 64, limit: 64 })
    const fullTail = atob(tail.dataBase64).includes('COMPLETE_LARGE_TOOL_TAIL')
    await window.scry.setCwd(null)
    let foreignContentDenied = false
    try { await window.scry.recorderContentPage({ source: 'app-trace', ref }) } catch { foreignContentDenied = true }
    await window.scry.setCwd(cwd)
    const stats = await window.scry.stats()
    return {
      sameRun: outcome.event.runId === started.runId,
      externalSessionId,
      loadedTurns: loaded.length,
      boundedHistory: JSON.stringify(loaded).length < 64 * 1024,
      fullTail,
      foreignContentDenied,
      hasTool: loaded.some((turn) => turn.items.some((item) => item.stage === 'tool_use')),
      rawInput: loaded.some((turn) => turn.items.some((item) => JSON.stringify(item.input ?? item.inputContent ?? null).includes('sk-ant-api03-scry-smoke-not-a-real-key-000000'))),
      rawOutput: loaded.some((turn) => turn.items.some((item) => item.stage === 'tool_result' && JSON.stringify(item.output ?? item.text ?? item.outputContent ?? null).includes('sk-ant-api03-scry-smoke-not-a-real-key-000000'))),
      statsStatus: stats.status,
      statsTurns: stats.totals.turns
    }
  })()`)
  assert.equal(lifecycleSmoke.sameRun, true)
  assert.ok(lifecycleSmoke.externalSessionId)
  assert.ok(lifecycleSmoke.loadedTurns >= 1)
  assert.equal(lifecycleSmoke.hasTool, true)
  assert.equal(lifecycleSmoke.boundedHistory, true, 'large tool body must not cross history IPC inline')
  assert.equal(lifecycleSmoke.fullTail, true, 'the entire captured body must remain inspectable')
  assert.equal(lifecycleSmoke.foreignContentDenied, true, 'content reference must not cross workspace scope')
  assert.equal(lifecycleSmoke.rawInput, true, 'captured tool input must survive archive reload verbatim')
  assert.equal(lifecycleSmoke.rawOutput, true, 'captured tool output must survive archive reload verbatim')
  assert.equal(lifecycleSmoke.statsStatus, 'ready')
  assert.ok(lifecycleSmoke.statsTurns >= 1)

  const historyReloadSmoke = await evaluate(`(async () => {
    const cwd = ${JSON.stringify(canonicalWorkspace)}
    const externalSessionId = ${JSON.stringify(lifecycleSmoke.externalSessionId)}
    let cleanupDone = () => {}
    let cleanupError = () => {}
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('second-turn history fixture timed out')), 15_000)
      cleanupDone = window.scry.onTurnDone((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        resolve(event)
      })
      cleanupError = window.scry.onError((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        reject(new Error(event.message))
      })
    })
    const started = await window.scry.start({ providerId: 'codex', cwd, expectedSessionId: externalSessionId, prompt: 'latest second-turn history' })
    const ended = await terminal
    const context = { providerId: 'codex', cwd, externalSessionId }
    const first = await window.scry.loadSession(context)
    const reopened = await window.scry.loadSession(context)
    return {
      sameSession: ended.externalSessionId === externalSessionId,
      firstLatest: first?.turns.at(-1)?.runId === started.runId,
      reopenedLatest: reopened?.turns.at(-1)?.runId === started.runId,
      latestPrompt: reopened?.turns.at(-1)?.userText,
      bothTurns: reopened?.turns.length >= 2
    }
  })()`)
  assert.deepEqual(historyReloadSmoke, {
    sameSession: true, firstLatest: true, reopenedLatest: true,
    latestPrompt: 'latest second-turn history', bothTurns: true
  })

  return { lifecycleSmoke, historyReloadSmoke }
}
