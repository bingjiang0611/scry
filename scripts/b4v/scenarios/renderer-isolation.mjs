// B4-V「renderer 隔离」: with the switch on, the renderer is exactly as boxed in as with it
// off: no Node globals, only the typed window.scry surface, the production CSP, a
// sandboxed renderer process, and no way to reach the daemon's local.sock from the page.
import { join } from 'node:path'
import { API_TREE_EXPRESSION, functionPaths, genericChannelLeaks, surfaceDifference } from '../api-detect.mjs'
import { attempt } from '../app.mjs'
import { appOwnedProcesses } from '../fixture.mjs'
import { openChecked, runScenario } from '../kit.mjs'
import { recordNotRun, recordStep } from '../report.mjs'

const commonPlan = [
  { id: 'no-node-globals', expected: 'require, process, module, Buffer, window.ipcRenderer and window.electron are all undefined in the page' },
  { id: 'preload-typed-only', expected: 'window.scry exposes typed methods only: no generic invoke/send/ipcRenderer/socket/localOp/forward leaf' },
  { id: 'csp-enforced', expected: "a blocked request reports the production CSP: connect-src 'none', script-src 'self' without 'unsafe-eval'" },
  { id: 'local-sock-unreachable', expected: 'fetch, XHR and WebSocket aimed at <userData>/daemon/local.sock all fail from the page' },
  { id: 'renderer-sandboxed', expected: 'the App\'s renderer processes run without --no-sandbox' }
]
export const daemonPlan = [
  ...commonPlan,
  { id: 'matches-control', expected: 'the CSP text and the window.scry surface are identical to the switch-off control' }
]

const GLOBALS = `({
  require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer,
  ipcRenderer: typeof window.ipcRenderer, electron: typeof window.electron, scry: typeof window.scry
})`

// Violation events are dispatched asynchronously; the probe waits for them, bounded.
const PROBE = (socket) => `(async () => {
  const socket = ${JSON.stringify(socket)}
  const violations = []
  const listener = (event) => violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, policy: event.originalPolicy })
  document.addEventListener('securitypolicyviolation', listener)
  const attempts = {}
  try { await fetch('file://' + socket); attempts.fetchFile = 'resolved' } catch (error) { attempts.fetchFile = 'rejected:' + error.name }
  try { await fetch('http://127.0.0.1:9/b4v-probe'); attempts.fetchHttp = 'resolved' } catch (error) { attempts.fetchHttp = 'rejected:' + error.name }
  attempts.xhr = await new Promise((resolve) => {
    try {
      const request = new XMLHttpRequest()
      request.onload = () => resolve('loaded')
      request.onerror = () => resolve('error')
      request.open('GET', 'file://' + socket)
      request.send()
    } catch (error) { resolve('threw:' + error.name) }
  })
  attempts.websocket = await new Promise((resolve) => {
    try {
      const ws = new WebSocket('ws+unix://' + socket)
      ws.onopen = () => { ws.close(); resolve('open') }
      ws.onerror = () => resolve('error')
      setTimeout(() => resolve('no-answer'), 2000)
    } catch (error) { resolve('threw:' + error.name) }
  })
  const deadline = Date.now() + 2000
  while (violations.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  document.removeEventListener('securitypolicyviolation', listener)
  return { attempts, violations }
})()`

export function cspVerdict(policy) {
  const text = String(policy ?? '')
  return {
    policy: text,
    connectNone: /(^|;)\s*connect-src 'none'/.test(text),
    scriptSelfOnly: /(^|;)\s*script-src 'self'(;|$)/.test(text),
    noUnsafeEval: !/unsafe-eval/.test(text)
  }
}

async function exercise(ctx, scenario, fixture, mode) {
  const app = await openChecked(ctx, scenario, fixture, { mode, label: 'app-1' })
  const globals = await attempt(app, GLOBALS)
  const g = globals.ok ? globals.value : {}
  recordStep(scenario, { id: 'no-node-globals', actual: globals.ok ? g : globals,
    pass: globals.ok && ['require', 'process', 'module', 'Buffer', 'ipcRenderer', 'electron'].every((key) => g[key] === 'undefined') && g.scry === 'object' })

  const tree = await attempt(app, API_TREE_EXPRESSION)
  const paths = tree.ok ? functionPaths(tree.value) : []
  const leaks = genericChannelLeaks(paths)
  recordStep(scenario, { id: 'preload-typed-only', actual: { functions: paths.length, leaks }, pass: tree.ok && paths.length > 0 && leaks.length === 0 })

  const socket = join(fixture.daemonState, 'local.sock')
  const probe = await attempt(app, PROBE(socket))
  const policy = probe.ok ? probe.value.violations.find((violation) => violation.policy)?.policy : undefined
  const csp = cspVerdict(policy)
  recordStep(scenario, { id: 'csp-enforced', actual: { ...csp, violations: probe.ok ? probe.value.violations.length : probe },
    pass: Boolean(policy) && csp.connectNone && csp.scriptSelfOnly && csp.noUnsafeEval })
  const attempts = probe.ok ? probe.value.attempts : null
  recordStep(scenario, { id: 'local-sock-unreachable', actual: attempts ?? probe,
    pass: Boolean(attempts) && attempts.fetchFile.startsWith('rejected') && attempts.xhr !== 'loaded' && attempts.websocket !== 'open' })

  const renderers = appOwnedProcesses(app.pid, fixture).filter((row) => /--type=renderer/.test(row.command))
  const unsandboxed = renderers.filter((row) => /--no-sandbox/.test(row.command))
  recordStep(scenario, { id: 'renderer-sandboxed', actual: { renderers: renderers.map((row) => row.pid), unsandboxed: unsandboxed.map((row) => row.pid) },
    pass: renderers.length > 0 && unsandboxed.length === 0 })
  return { csp: policy ?? null, paths }
}

export async function run(ctx) {
  let control = null
  if (!ctx.options.noControls) {
    await runScenario(ctx, { id: 'renderer-isolation-control', title: 'renderer 隔离（开关关闭对照）', mode: 'switch-off', label: 'render-off', plan: commonPlan },
      async ({ scenario, fixture }) => { control = await exercise(ctx, scenario, fixture, 'switch-off') })
  }
  return runScenario(ctx, { id: 'renderer-isolation', title: 'renderer 隔离', mode: 'daemon', label: 'render', plan: daemonPlan }, async ({ scenario, fixture }) => {
    const observed = await exercise(ctx, scenario, fixture, 'daemon')
    if (!control) {
      recordNotRun(scenario, { id: 'matches-control', reason: 'switch-off control did not complete (--no-controls or it aborted)' })
      return
    }
    const difference = surfaceDifference(observed.paths, control.paths)
    recordStep(scenario, { id: 'matches-control', actual: { cspEqual: observed.csp === control.csp, ...difference },
      pass: observed.csp !== null && observed.csp === control.csp && difference.onlyInDaemon.length === 0 && difference.onlyInControl.length === 0 })
  })
}
