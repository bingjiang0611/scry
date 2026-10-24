import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { connectCdp } from './electron-security-cdp.mjs'
import { exerciseUnifiedConversation, verifyUnifiedConversationRestart } from './unified-conversation-smoke.mjs'

export async function exerciseUnified(smokeContext) {
  const { cdp: initialCdp, child: initialChild, stopOwnedApp, launchApp, waitForTarget, port, smokeIdentity: initialIdentity, setSmokeIdentity, fixture, evaluate: initialEvaluate, userDataDir, workspace, canonicalWorkspace, conversationInputs, conversationCalls, stderr } = smokeContext
  let cdp = initialCdp
  let child = initialChild
  let smokeIdentity = initialIdentity
  let evaluate = initialEvaluate

    const fixtureValue = fixture || { workspace: canonicalWorkspace, userData: userDataDir, inputsFile: conversationInputs, callsFile: conversationCalls }
    const result = await exerciseUnifiedConversation(cdp, evaluate, fixtureValue)
    for (const changedIdentity of [false, true]) {
      cdp.close()
      await stopOwnedApp(child)
      if (changedIdentity) { smokeIdentity = 'changed'; setSmokeIdentity(smokeIdentity) }
      child = launchApp()
      const restarted = await waitForTarget(port, () => child)
      cdp = connectCdp(restarted.page.webSocketDebuggerUrl)
      evaluate = async (expression) => { const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed'); return response.result?.value }
      await cdp.send('Runtime.enable')
      await verifyUnifiedConversationRestart(evaluate, fixtureValue, result, changedIdentity)
    }
    cdp.close()
    const artifactPaths = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html',
      ...readdirSync(resolve('out/renderer/assets')).filter(name => /\.(js|css)$/.test(name)).map(name => `out/renderer/assets/${name}`)]
    const artifactHashes = Object.fromEntries(artifactPaths.map((path) =>
      [path, createHash('sha256').update(readFileSync(resolve(path))).digest('hex')]))
    writeFileSync(join(result.screenshots, 'verification.json'), JSON.stringify({ ...result, restarts: 2, identityChangeFresh: true, artifactHashes }, null, 2))
    console.log(JSON.stringify({ test: result.test, conversationId: result.id, turns: result.runIds.length,
      providerInvocations: result.receipts.length, restarts: 2, identityChangeFresh: true, evidence: result.screenshots }))
    return
  return true
}
