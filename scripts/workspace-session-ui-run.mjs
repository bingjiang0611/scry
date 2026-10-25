import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { assertPendingDraft } from './workspace-session-ui-picker.mjs'
const json = JSON.stringify
export const wait = async (probe, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}

export async function sendWorkspacePrompt({ inputs, type, click, cdp, evaluate, record }, prompt,
  pauseUntilRecorded = false, expectedReply = 'isolated remote assistant evidence') {
  const count = inputs().length
  await type('textarea', prompt)
  await wait(() => evaluate(`document.querySelector('.send')?.disabled === false`), 'send ready')
  await click('.send')
  if (pauseUntilRecorded) {
    await assertPendingDraft(cdp, prompt)
    await cdp.send('Debugger.pause')
  }
  let input
  try {
    input = await wait(() => inputs().length > count && inputs()[count], 'one Provider invocation')
    if (pauseUntilRecorded) await record(input.cwd, input.runId)
  } finally {
    if (pauseUntilRecorded) await cdp.send('Debugger.resume')
  }
  assert.equal(input.prompt, prompt)
  // Settled runs are removed synchronously from the registry: providerSettled=true is not a
  // pollable snapshot state. Require the authoritative Git gate, registry and rendered result.
  const terminal = await wait(() => evaluate(`(async () => {
    const repo = await window.scry.sourceControl.read(${json(input.cwd)})
    const active = await window.scry.activeRuns()
    const turn = document.querySelector('[data-run-id=' + ${json(json(input.runId))} + ']')
    const location = document.querySelector('.tb-thread')?.title === ${json(input.cwd)}
    window.__workspaceTerminalProbe = { repo, active: active.map(run => run.runId), turnFound: Boolean(turn), location, header: document.querySelector('.tb-thread')?.title }
    return repo.status === 'available' && repo.data.writeBlocker === null && !active.some(run => run.runId === ${json(input.runId)}) &&
      turn?.textContent.includes(${json(expectedReply)}) && location
      ? { cwd: ${json(input.cwd)}, runId: ${json(input.runId)}, gate: repo.data.writeBlocker, active: active.map(run => run.runId) } : null
  })()`), 'recorded run displayed in its target and admission gate released')
  const run = { cwd: terminal.cwd, runId: terminal.runId }
  assert.equal(inputs().length, count + 1, 'a send must not invoke the Provider twice')
  assert.equal(await evaluate(`document.querySelector('textarea').value`), '', 'accepted text is not left as a resend draft')
  assert.equal(await evaluate(`document.querySelector('.workspace-context-strip button').disabled`), true, 'bound session has a read-only workspace strip')
  assert.equal(run.cwd, realpathSync(input.cwd), 'Provider and focused session must bind the same canonical cwd')
  return { input, run }
}
