import assert from 'node:assert/strict'

/** Functional real-App acceptance only; its diagnostic reads are not a latency benchmark. */
export async function exerciseConcurrentDiffDemand({ evaluate, activate, wait, conversations }) {
  assert.ok(conversations.length >= 2, 'Demand acceptance requires at least two actual conversations')
  const runId = await evaluate('window.__concurrentStarts[0].runId')
  const run = `(await window.scry.activeRuns()).find(run => run.runId === ${JSON.stringify(runId)})`
  const preview = `(${run})?.items.findLast(event => event.stage === 'turn_diff_preview')?.turnDiff`
  await wait(`(${preview})?.status === 'captured'`)
  const first = await evaluate(`(async () => (${preview}))()`)
  assert.ok(first.files.length > 0 && first.files.length <= 4, 'Initial view must attach early enough to cover a hidden preview interval')

  await activate(`button[data-conversation-id="${conversations[1].id}"]`)
  await wait(`document.querySelector('main.unified-conversation[data-conversation-id="${conversations[1].id}"]')`)
  // A workload milestone, not a sleep: the provider keeps writing while its view
  // is absent, through more than the existing eight-second preview interval.
  await wait(`(${run})?.items.filter(event => event.kind === 'tool' && event.stage === 'tool_result').length >= 14`)
  const hidden = await evaluate(`(async () => ({ done: (${run})?.done, preview: (${preview}) }))()`)
  assert.equal(hidden.done, false, 'The hidden run must still be active')
  assert.equal(hidden.preview.afterAt, first.afterAt, 'Hidden view published a new background preview')

  const requestedAt = await evaluate('Date.now()')
  await activate(`button[data-conversation-id="${conversations[0].id}"]`)
  await wait(`await (async () => {
    if (Date.now() - ${requestedAt} > 2000) throw new Error('Returning view did not receive a fresh preview within 2 seconds');
    const current = ${run};
    const snapshot = current?.items.findLast(event => event.stage === 'turn_diff_preview')?.turnDiff;
    return !current?.done && snapshot?.afterAt > ${JSON.stringify(first.afterAt)} && snapshot.files.length >= 14;
  })()`)
  const fresh = await evaluate(`(async () => (${preview}))()`)
  const fileLabel = JSON.stringify(fresh.files.length + ' files')
  await wait(`await (async () => {
    if (Date.now() - ${requestedAt} > 2000) throw new Error('Fresh preview did not reach the rendered view within 2 seconds');
    return document.querySelector('main.unified-conversation .files-summary.diff .fh-file-count')?.textContent === ${fileLabel};
  })()`)
  const renderedDiffFiles = await evaluate("document.querySelector('main.unified-conversation .files-summary.diff .fh-file-count')?.textContent")
  const proof = { runId, firstAfterAt: first.afterAt, hiddenAfterAt: hidden.preview.afterAt,
    returnedAfterAt: fresh.afterAt, firstFiles: first.files.length, returnedFiles: fresh.files.length, renderedDiffFiles,
    hiddenRunStillWorking: true, staleTimeNotRewritten: true, freshBeforeTerminal: true }
  return proof
}
