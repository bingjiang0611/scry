import assert from 'node:assert/strict'

/** Real React/input path with a scripted bridge. Main routing has its own App probe. */
export async function checkWorkflowMessageChoiceUi({ read, wait, click, key, type, queue, snapshot, send, capturedSubmission }) {
  const group = '.conversation-message-choice'
  const value = () => read(`document.querySelector('${group} input:checked').value`)
  const choose = async choice => {
    await click(`${group} input[value="${choice}"]`)
    await wait(`document.querySelector('${group} input:checked').value===${JSON.stringify(choice)}`)
  }
  const direct = runId => ({ kind: 'direct', runId, disposition: 'created' })
  const baseline = await snapshot()
  await choose('default')
  key('Right')
  await wait(`document.querySelector('${group} input[value="direct"]').checked`)
  key('Left')
  await wait(`document.querySelector('${group} input[value="default"]').checked`)

  // The first response has no effects. Native-context negotiation must preserve
  // the choice and original command identity, not silently re-enable auto routing.
  await choose('direct')
  await type('direct with missing native context')
  await queue({ kind: 'needs_native_context' })
  await queue(direct('override-native'))
  await send()
  await wait('window.conversationCommandFixture.draft()===""')
  const negotiated = (await snapshot()).submissions.slice(baseline.submissions.length)
  assert.equal(negotiated.length, 2)
  assert.equal(negotiated[0].message.workflowOverride, 'direct')
  assert.equal(negotiated[1].message.workflowOverride, 'direct')
  assert.equal(negotiated[1].commandId, negotiated[0].commandId)
  assert.equal(negotiated[1].message.expectedContinuationKey, 'synthetic-native-key')
  assert.equal(await value(), 'default')

  // A definitive rejection has not consumed the choice or the draft. A later
  // accepted workflow capture opens configuration, not execution or replanning.
  await choose('workflow')
  await type('one-message workflow goal')
  await queue({ kind: 'rejected', error: 'Synthetic rejection before capture' })
  await send()
  await wait('document.body.textContent.includes("Synthetic rejection before capture")')
  assert.equal(await value(), 'workflow')
  const beforeCapture = await snapshot()
  await queue({ kind: 'control', commandId: 'override-capture', action: 'open_workflow_planner',
    command: '/scry-workflow run one-message workflow goal', workspace: '/synthetic', submission: capturedSubmission })
  await send()
  await wait('document.querySelector(".workflow-goal textarea")')
  assert.equal((await snapshot()).submissions.at(-1).message.workflowOverride, 'workflow')
  assert.equal(await value(), 'default')
  assert.equal(await read('window.conversationCommandFixture.draft()'), 'one-message workflow goal')
  assert.equal((await snapshot()).workflowPlans.length, beforeCapture.workflowPlans.length)
  assert.equal((await snapshot()).starts.length, beforeCapture.starts.length)
  key('Escape')
  await wait('!document.querySelector(".workflow-modal")')

  // Unknown ACKs retain an immutable request and lock the selector. Readback
  // never invents a fresh id or upgrades a different per-message choice.
  await choose('direct')
  await type('preserve the one-message choice after lost ACK')
  const beforeUnknown = (await snapshot()).submissions.length
  await read('window.conversationCommandFixture.outcomes.push(new Error("Synthetic override lost ACK"))')
  await send()
  await wait('document.querySelector(".conversation-recovery button") && !document.querySelector(".conversation-recovery button").disabled')
  assert.equal(await read(`document.querySelector('${group}').disabled`), true)
  const original = (await snapshot()).submissions.at(-1)
  assert.equal((await snapshot()).submissions.length, beforeUnknown + 1)
  await queue(direct('override-readback'))
  await click('.conversation-recovery button')
  await wait('!document.querySelector(".conversation-recovery") && window.conversationCommandFixture.draft()===""')
  assert.deepEqual((await snapshot()).submissions.at(-1), original)
  assert.equal(await value(), 'default')

  await type('the next message uses conversation mode')
  await queue(direct('override-consumed'))
  await send()
  await wait('window.conversationCommandFixture.draft()===""')
  assert.equal((await snapshot()).submissions.at(-1).message?.workflowOverride, undefined)
  assert.equal((await snapshot()).metadata.length, baseline.metadata.length, 'per-message choices must not change conversation/native metadata')
  return { nativeContextPreserved: true, rejectionRetainsChoice: true, captureOnly: true,
    unknownRequestIdentity: true, choiceConsumedOnce: true, keyboardRadioNavigation: true }
}
