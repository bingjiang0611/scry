// Autonomous REAL-qoder check of the run seam WITHOUT the phone/relay: builds the
// production ProviderRegistry and drives the SAME createRemoteRunBinding used by
// index.ts, running qoder in the authorized project. Proves the run+output path
// (lifecycle markers + streamed real content) with REAL tokens. Combined with
// relay-run-smoke (transport proven), this is the phone flow minus the UI taps.
import 'reflect-metadata'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { ProviderRegistry } from '../../src/main/providers/registry.ts'
import { createBuiltInProviderAdapters } from '../../src/main/providers/index.ts'
import { createRemoteRunBinding } from '../../src/main/remote/remote-run-binding.ts'

const PROJECT = realpathSync(process.env.SCRY_LIVE_PROJECT || '/tmp/scry-live-project')
const scratch = mkdtempSync(join(tmpdir(), 'scry-qoder-check-'))
const adapters = createBuiltInProviderAdapters(homedir(), join(scratch, 'codex'), join(scratch, 'oca'), join(scratch, 'ocs'))
const registry = new ProviderRegistry(adapters, { disabledProviders: new Set(), runControlsEnabled: true })

// Capture the Mac-catalog bridge callbacks: onRunStarted (pending) + onRunSession
// (the Provider's REAL resumable session id). In the real app these write an
// AppSession so the run shows up in the Mac session history.
let catalogStarted = null
let catalogSession = null
const start = createRemoteRunBinding({
  run: (providerId, request) => registry.run(providerId, { ...request, permissionMode: 'full_access' }),
  onRunStarted: (info) => { catalogStarted = info; console.log(`[catalog] onRunStarted scryRunId=${info.scryRunId} provider=${info.providerId}`) },
  onRunSession: (info) => { catalogSession = info; console.log(`[catalog] onRunSession externalSessionId=${info.externalSessionId}`) }
})

const progress = []
const output = []
const prompt = process.env.SCRY_PROMPT || '用一句话说明 greet.js 的作用，不要修改文件。'
console.log(`[check] qoder run in ${PROJECT}\n[check] prompt: ${prompt}\n`)
try {
  await start({
    runId: 'binding-check',
    routing: { cwd: PROJECT, providerId: 'qoder', prompt },
    progress: (m) => { progress.push(m); try { const o = JSON.parse(m); console.log(`[life] ${o.event}${o.status ? ':' + o.status : ''}`) } catch { console.log('[life]', m) } },
    output: (c) => { output.push(c); const t = c.text.length > 200 ? c.text.slice(0, 200) + '…' : c.text; console.log(`«${c.kind}» ${t.replace(/\n/g, ' ')}`) }
  })
  console.log(`\n[check] ✅ settled. lifecycle markers=${progress.length} output chunks=${output.length}`)
  console.log(`[check] output kinds: ${JSON.stringify(output.reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + 1; return a }, {}))}`)
  if (!catalogStarted) { console.log('[check] ✗ onRunStarted never fired (Mac catalog would miss the run)'); process.exit(1) }
  if (!catalogSession || !catalogSession.externalSessionId) { console.log('[check] ✗ onRunSession/externalSessionId missing (not resumable on Mac)'); process.exit(1) }
  console.log(`[check] ✅ Mac-catalog bridge OK: pending recorded + real externalSessionId=${catalogSession.externalSessionId}`)
} catch (e) {
  console.log(`\n[check] ✗ failed: ${e?.message || e}`)
  process.exit(1)
}
process.exit(0)
