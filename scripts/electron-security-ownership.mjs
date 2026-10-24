import { connectCdp } from './electron-security-cdp.mjs'
import { exerciseConversationOwnership, prepareOwnershipRecoveryFailure, exerciseOwnershipRecoveryFailure } from './conversation-ownership-smoke.mjs'

export async function exerciseOwnership(smokeContext) {
  const { ownershipFixture, evaluate: initialEvaluate, cdp: initialCdp, child: initialChild, stopOwnedApp, launchApp, waitForTarget, port } = smokeContext
  let evaluate = initialEvaluate
  let cdp = initialCdp
  let child = initialChild
  const result = await exerciseConversationOwnership(evaluate, ownershipFixture)
  cdp.close()
  await stopOwnedApp(child)
  const restorePermissions = prepareOwnershipRecoveryFailure(ownershipFixture)
  try {
    child = launchApp()
    const restarted = await waitForTarget(port, () => child)
    cdp = connectCdp(restarted.page.webSocketDebuggerUrl)
    evaluate = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed')
      return response.result?.value
    }
    await cdp.send('Runtime.enable')
    result.startupFailure = await exerciseOwnershipRecoveryFailure(evaluate, ownershipFixture, result)
    cdp.close()
  } finally {
    restorePermissions()
  }
  console.log(JSON.stringify(result))
  return true
}
