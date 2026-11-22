import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'

async function waitFor(read, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for ' + label)
}

export async function exerciseQuestion(smokeContext) {
  const { evaluate, cdp, workspace, badgeReceipt, focusRequest } = smokeContext
    const startupBadge = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    assert.equal(startupBadge.requests[0]?.count, 0, 'production startup must synchronize the empty unread count to Dock')
    assert.ok(startupBadge.initial.success && startupBadge.requests[0].success, 'native Dock badge operation unavailable')
    assert.equal(startupBadge.requests[0].nativeCount, 0)
    assert.equal(startupBadge.requests[0].dockBadge, '')
    const activate = async () => {
      appendFileSync(focusRequest, '\n')
      await evaluate(`(${waitFor.toString()})(() => document.hasFocus(), 'native foreground focus')`)
    }
    await activate()
    const pending = await evaluate(`(async () => {
      const waitFor = ${waitFor.toString()}
      const { runId } = await window.scry.start({
        providerId: 'codex', cwd: ${JSON.stringify(workspace)}, prompt: 'dock badge question smoke'
      })
      const pendingRun = async (questionId) => {
        const active = (await window.scry.activeRuns()).find(run => run.runId === runId)
        return active?.pendingQuestions?.some(question => question.questionId === questionId) ? active : null
      }
      const firstQuestionId = runId + ':question:1'
      await waitFor(() => pendingRun(firstQuestionId), 'initial question')
      await window.scry.focusRun(null)
      const answered = await window.scry.answerQuestion({
        runId, questionId: firstQuestionId, behavior: 'answered',
        answers: { 'Continue the isolated badge smoke?': 'Continue' }
      })
      if (!answered) throw new Error('Fixture question response was rejected')
      const run = await waitFor(() => pendingRun(runId + ':question:2'), 'background question')
      const unread = await waitFor(async () => {
        const snapshot = await window.scry.unreadSessions()
        return snapshot.unreadSessionKeys.length === 1 ? snapshot : null
      }, 'background question unread snapshot')
      return { runId, done: run.done, pendingCount: run.pendingQuestions.length, unread }
    })()`)
    await activate()
    const viewing = await evaluate(`(async () => {
      if (!document.hasFocus()) throw new Error('Native foreground focus unavailable before viewing the fixture run')
      await window.scry.focusRun(${JSON.stringify(pending.runId)})
      return { viewed: await window.scry.unreadSessions(), windowFocused: document.hasFocus() }
    })()`)
    const result = { ...pending, ...viewing }
    assert.equal(result.done, false, 'question attention must arrive before a terminal result')
    assert.equal(result.pendingCount, 1)
    assert.equal(result.unread.unreadSessionKeys.length, 1, 'background question must trigger Dock attention')
    assert.ok(result.windowFocused, 'viewing the run must occur in the native foreground')
    assert.equal(result.viewed.unreadSessionKeys.length, 0, `viewing the pending session must clear its attention: ${JSON.stringify(result)}`)
    const beforeRepeat = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    assert.ok(beforeRepeat.residual?.success, 'fixture must recreate a native badge after the session is read')
    assert.equal(beforeRepeat.residual.nativeCount, 1)
    assert.equal(beforeRepeat.residual.dockBadge, '1')
    const repeatedView = await evaluate(`(async () => {
      if (!document.hasFocus()) throw new Error('Native foreground focus unavailable before repeating the view')
      await window.scry.focusRun(${JSON.stringify(result.runId)})
      const snapshot = await window.scry.unreadSessions()
      const windowFocused = document.hasFocus()
      await window.scry.stop(${JSON.stringify(result.runId)})
      return { snapshot, windowFocused }
    })()`)
    assert.ok(repeatedView.windowFocused, 'repeated viewing must occur in the native foreground')
    assert.deepEqual(repeatedView.snapshot, result.viewed, 'repeated viewing must not manufacture unread changes')
    const badgeLifecycle = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    const counts = badgeLifecycle.requests.map(request => request.count)
    assert.deepEqual(counts.filter((count, index) => index === 0 || count !== counts[index - 1]), [0, 1, 0])
    assert.equal(badgeLifecycle.requests.length, beforeRepeat.requests.length + 1,
      'repeated viewing of an already-read session must resynchronize Dock')
    const lastRequest = badgeLifecycle.requests.at(-1)
    assert.equal(lastRequest.count, 0)
    assert.equal(lastRequest.dockBadge, '')
    for (const request of badgeLifecycle.requests) {
      assert.ok(request.success, 'native Dock badge operation unavailable')
      assert.equal(request.nativeCount, request.count)
    }
    console.log(JSON.stringify({ ok: true, badgeLifecycle, questionAttention: result, repeatedView }))
    cdp.close()
    return
}
