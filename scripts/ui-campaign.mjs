import { spawn } from 'node:child_process'

const DEADLINE_MS = 30_000

// One bounded campaign: a single hidden Electron process that must finish inside DEADLINE_MS.
// A zero exit code alone is not proof of success — the merged result line is required — and a
// campaign that hit the deadline stays failed even if the child later exits cleanly, because the
// work it was killed in the middle of was never reported. timedOut/lastFixture are kept so a
// deadline is not reported as a case failure.
export function runUiCampaign({ electron, script, argv = [], env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [script, '--disable-gpu', '--disable-backgrounding-occluded-windows', ...argv], {
      env, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let timedOut = false
    const startedAt = Date.now()
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, DEADLINE_MS)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_UI_SMOKE_RESULT=(.+)$/m)?.[1]
      if (timedOut || code !== 0 || !result) {
        reject(new Error(`Hidden UI fixture failed (${code ?? signal}); timedOut=${timedOut}; elapsedMs=${Date.now() - startedAt}; lastFixture=${[...output.matchAll(/^SCRY_UI_FIXTURE=(.+)$/gm)].at(-1)?.[1] ?? 'unknown'}:\n${output.slice(-8000)}`))
        return
      }
      try {
        resolve(JSON.parse(result))
      } catch (error) {
        // An unparseable result is a failed campaign, never a silent success.
        reject(error)
      }
    })
  })
}
