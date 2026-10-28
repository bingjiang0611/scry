import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { connectCdp, freePort, waitForTarget } from './electron-security-cdp.mjs'
import { measureNativeSessionOpen } from './session-open-timing.mjs'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const userData = process.env.SCRY_WORKFLOW_USER_DATA
assert.ok(userData, 'SCRY_WORKFLOW_USER_DATA is required')
const temp = mkdtempSync(join(tmpdir(), 'scry-workflow-open-'))
const bootstrap = join(temp, 'app')
mkdirSync(bootstrap)
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'main.cjs' }))
writeFileSync(join(bootstrap, 'main.cjs'), `
const { app } = require('electron')
app.setAppPath(${JSON.stringify(root)})
require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
require(${JSON.stringify(join(root, metadata.main))})
`)

let child
let cdp
let output = ''
const capture = chunk => { output += chunk.toString() }
const waitForProviderExit = async () => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = inspectOwnedApp(child)
    const providerAlive = state.state === 'observed' && state.processes.some(process => {
      const executable = process.command.trim().split(/\s+/, 1)[0]
      return executable === 'pi' || executable.endsWith('/pi')
    })
    if (!providerAlive) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Pi history reader did not exit: ${JSON.stringify(inspectOwnedApp(child))}`)
}
try {
  const port = await freePort()
  child = spawn(electron, [bootstrap, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
    cwd: root,
    env: {
      ...process.env,
      SCRY_TEST_APP: '1',
      SCRY_PERF_LOG: '1',
      ELECTRON_ENABLE_LOGGING: '1',
      SCRY_DISABLED_PROVIDERS: 'claude,codex,qoder,opencode',
      SCRY_REMOTE_HOST: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const { page } = await waitForTarget(port, () => child, 60_000, () => output)
  cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const evaluate = async expression => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  const wait = async (expression, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    while (!await evaluate(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(-5000)')}`)
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  }
  const click = async expression => {
    const point = await evaluate(`(() => {
      const element = ${expression}
      if (!element) throw new Error('Native click target missing')
      element.scrollIntoView({ block: 'center' })
      const rect = element.getBoundingClientRect()
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      if (!element.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Native click target obscured')
      return point
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const target = `Array.from(document.querySelectorAll('button.sb-sess')).find(element => element.textContent.includes('workflow'))`
  await wait(`${target} != null && typeof window.scry === 'object'`, 60_000)
  await evaluate(`(() => {
    const target = ${target}
    window.__workflowFirstTurnMs = null
    window.__workflowClickAt = performance.now()
    window.__workflowTiming = (${measureNativeSessionOpen.toString()})(
      target,
      () => target.getAttribute('aria-current') === 'true' && document.querySelector('.chat-transcript')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.transcript-turn').length > 0,
      () => target.getAttribute('aria-current') === 'true'
    )
    const inspect = () => {
      if (window.__workflowFirstTurnMs == null && document.querySelectorAll('.transcript-turn').length > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (window.__workflowFirstTurnMs == null && document.querySelectorAll('.transcript-turn').length > 0) {
            window.__workflowFirstTurnMs = performance.now() - window.__workflowClickAt
          }
        }))
      }
    }
    window.__workflowObserver = new MutationObserver(inspect)
    window.__workflowObserver.observe(document.querySelector('.chat-transcript'), { childList: true, characterData: true, subtree: true })
    inspect()
  })()`)
  await click(target)
  await wait(`window.__workflowFirstTurnMs != null && document.querySelector('.chat-transcript')?.getAttribute('aria-busy') === 'false'`, 60_000)
  const result = await evaluate(`(async () => {
    const timing = await window.__workflowTiming
    window.__workflowObserver.disconnect()
    return {
      ...timing,
      firstTurnMs: window.__workflowFirstTurnMs,
      renderedTurnsAtReady: document.querySelectorAll('.transcript-turn').length,
      transcriptBytesAtReady: document.querySelector('.chat-transcript')?.textContent.length ?? 0,
      errors: document.querySelector('.composer-error')?.textContent ?? null
    }
  })()`)
  await wait(`document.querySelector('.chat-transcript')?.getAttribute('data-history-source') === 'authoritative'`, 60_000)
  result.authorityMs = await evaluate('performance.now() - window.__workflowClickAt')
  result.renderedTurnsAfterAuthority = await evaluate("document.querySelectorAll('.transcript-turn').length")
  result.transcriptBytesAfterAuthority = await evaluate("document.querySelector('.chat-transcript')?.textContent.length ?? 0")
  const fullResponse = `Array.from(document.querySelectorAll('button.turn-flow-reveal')).find(element => element.textContent.includes('显示完整回复'))`
  result.fullResponseControl = await evaluate(`${fullResponse} != null`)
  if (result.fullResponseControl) {
    const beforeExpand = result.transcriptBytesAfterAuthority
    await click(fullResponse)
    await wait(`${fullResponse} == null && (document.querySelector('.chat-transcript')?.textContent.length ?? 0) > ${beforeExpand}`, 60_000)
    result.transcriptBytesAfterExpand = await evaluate("document.querySelector('.chat-transcript')?.textContent.length ?? 0")
  }
  await waitForProviderExit()
  assert.ok(result.nativeOpenMs < 100, `workflow session shell exceeded 100ms: ${result.nativeOpenMs}`)
  assert.ok(result.firstTurnMs < 100, `workflow session first turn exceeded 100ms: ${result.firstTurnMs}`)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(output.slice(-8000))
  throw error
} finally {
  cdp?.close()
  if (child) await stopOwnedApp(child)
  rmSync(temp, { recursive: true, force: true })
}
