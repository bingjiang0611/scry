import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { connectCdp } from './electron-security-cdp.mjs'
import { exerciseMetaPromptsApp } from './meta-prompts-ui-checks.mjs'

export async function exerciseMeta(smokeContext) {
  const { cdp: initialCdp, child: initialChild, stopOwnedApp, launchApp, waitForTarget, port, smokeIdentity: initialIdentity, fixture, evaluate: initialEvaluate, userDataDir, workspace, canonicalWorkspace, conversationInputs, conversationCalls, stderr } = smokeContext
  let cdp = initialCdp
  let child = initialChild
  let smokeIdentity = initialIdentity
  let evaluate = initialEvaluate

    const result = await exerciseMetaPromptsApp(cdp, evaluate)
    cdp.close()
    await stopOwnedApp(child)
    child = launchApp()
    const restarted = await waitForTarget(port, () => child)
    cdp = connectCdp(restarted.page.webSocketDebuggerUrl)
    evaluate = async (expression) => { const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed'); return response.result?.value }
    await cdp.send('Runtime.enable')
    await evaluate(`(async () => {
      const deadline = Date.now() + 5000;
      while (!document.querySelector('[aria-label="主要视图"] .sb-navitem:last-child')) {
        if (Date.now() > deadline) throw new Error('Restarted App navigation missing');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      document.querySelector('[aria-label="主要视图"] .sb-navitem:last-child').click();
    })()`)
    await evaluate(`(async () => {
      const deadline = Date.now() + 5000;
      while (document.querySelector('.mp-body')?.textContent !== ${JSON.stringify(result.body)}) {
        if (Date.now() > deadline) throw new Error('Prompt lost after full App restart');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    })()`)
    cdp.close()
    console.log(JSON.stringify({ ...result, coldRestartPersistence: true }))
    return
  return true
}
