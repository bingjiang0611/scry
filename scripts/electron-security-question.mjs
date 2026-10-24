import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export async function exerciseQuestion(smokeContext) {
  const { evaluate, cdp, workspace, badgeReceipt } = smokeContext
    const startupBadge = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    assert.equal(startupBadge.requests[0]?.count, 0, 'production startup must synchronize the empty unread count to Dock')
    if (startupBadge.requests[0].success) {
      assert.equal(startupBadge.requests[0].nativeCount, 0)
      assert.equal(startupBadge.requests[0].dockBadge, '')
    }
    const result = await evaluate(`(async () => {
      const waitFor = async (read, label) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const value = await read()
          if (value) return value
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('Timed out waiting for ' + label)
      }
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
      const unread = await window.scry.unreadSessions()
      await window.scry.focusRun(runId)
      const viewed = await window.scry.unreadSessions()
      return { runId, done: run.done, pendingCount: run.pendingQuestions.length, unread, viewed }
    })()`)
    assert.equal(result.done, false, 'question attention must arrive before a terminal result')
    assert.equal(result.pendingCount, 1)
    assert.equal(result.unread.unreadSessionKeys.length, 1, 'background question must trigger Dock attention')
    assert.equal(result.viewed.unreadSessionKeys.length, 0, 'viewing the pending session must clear its attention')
    const beforeRepeat = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    assert.ok(beforeRepeat.residual, 'fixture must recreate a native badge after the session is read')
    if (beforeRepeat.residual.success) {
      assert.equal(beforeRepeat.residual.nativeCount, 1)
      assert.equal(beforeRepeat.residual.dockBadge, '1')
    }
    const repeatedView = await evaluate(`(async () => {
      await window.scry.focusRun(${JSON.stringify(result.runId)})
      const snapshot = await window.scry.unreadSessions()
      await window.scry.stop(${JSON.stringify(result.runId)})
      return snapshot
    })()`)
    assert.deepEqual(repeatedView, result.viewed, 'repeated viewing must not manufacture unread changes')
    const badgeLifecycle = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    const counts = badgeLifecycle.requests.map(request => request.count)
    assert.deepEqual(counts.filter((count, index) => index === 0 || count !== counts[index - 1]), [0, 1, 0])
    assert.equal(badgeLifecycle.requests.length, beforeRepeat.requests.length + 1,
      'repeated viewing of an already-read session must resynchronize Dock')
    const lastRequest = badgeLifecycle.requests.at(-1)
    assert.equal(lastRequest.count, 0)
    if (lastRequest.success) assert.equal(lastRequest.dockBadge, '')
    for (const request of badgeLifecycle.requests) {
      if (request.success) assert.equal(request.nativeCount, request.count)
    }
    console.log(JSON.stringify({ ok: true, badgeLifecycle, questionAttention: result, repeatedView }))
    cdp.close()
    return
}
