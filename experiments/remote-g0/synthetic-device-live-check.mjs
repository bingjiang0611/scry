// Drive the REAL Swift probe as a FRESH synthetic device against the RUNNING
// qoder host over the SAME wrangler LAN relay the phone uses. Isolates whether
// the phone's run-channel "socket hang up" is stale phone credentials (this
// succeeds -> re-pair fixes it) or a wrangler-DO/bundle transport bug (this also
// hangs up). Reads the fresh scry1 code the qoder host printed.
import { mkdtempSync, chmodSync, writeFileSync, accessSync, constants as fsC, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const code = readFileSync('/tmp/scry-code.txt', 'utf8').trim().replace(/^scry1:/, '')
const p = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
console.log(`[syn] relay=${p.relayHost}:${p.relayPort} tls=${p.relayTLS} host=${p.hostId.slice(0, 8)} pairing=${p.pairingId.slice(0, 8)}`)

const pkg = fileURLToPath(new URL('swift/', import.meta.url))
const { stdout: binPath } = await exec('swift', ['build', '--package-path', pkg, '--show-bin-path'], { timeout: 300_000 })
const probe = join(binPath.trim(), 'scry-remote-probe')
const generator = join(binPath.trim(), 'scry-enrollment-fixture')
accessSync(probe, fsC.X_OK); accessSync(generator, fsC.X_OK)

const dir = mkdtempSync(join(tmpdir(), 'scry-g0-syn-')); chmodSync(dir, 0o700)
const { stdout: fp } = await exec(generator, [dir], { timeout: 30_000, maxBuffer: 1 << 20 })
const csr = join(dir, 'swift-device.csr'), key = join(dir, 'swift-device.key'), boot = join(dir, 'swift-device-bootstrap.pem')
const anchor = join(dir, 'anchor.pem'); writeFileSync(anchor, p.anchorPEM, { mode: 0o600 })
console.log(`[syn] device fp=${fp.trim().slice(0, 16)}`)

const rp = async (args) => (await exec(probe, ['relay-pair', ...args], { timeout: 30_000, maxBuffer: 1 << 20 })).stdout
const proveArgs = ['prove', p.relayHost, String(p.relayPort), p.hostId, anchor, boot, key, p.pairingId, p.secret, csr, 'Synthetic Probe']

console.log('[syn] prove #1 (should reach pending; host auto-confirms in ~1s)...')
try { const out1 = await rp(proveArgs); console.log(`[syn]   -> ${out1.trim().split('\n')[0]}`) }
catch (e) { console.log(`[syn]   ✗ prove #1 error: ${e.message}`); process.exit(1) }

await new Promise((r) => setTimeout(r, 2500))
console.log('[syn] prove #2 (expect granted cert)...')
let grantedCertPem
try {
  const out2 = await rp(proveArgs)
  const [summary, ...pem] = out2.split('\n')
  console.log(`[syn]   -> ${summary}`)
  if (!pem.join('\n').includes('BEGIN CERTIFICATE')) { console.log('[syn] ✗ no granted cert yet'); process.exit(1) }
  grantedCertPem = join(dir, 'granted.pem'); writeFileSync(grantedCertPem, pem.join('\n'), { mode: 0o600 })
} catch (e) { console.log(`[syn]   ✗ prove #2 error: ${e.message}`); process.exit(1) }

// Run-channel projects over the same wrangler relay with fresh creds.
console.log('[syn] relay-run projects...')
let projectPath
try {
  const { stdout } = await exec(probe, ['relay-run', 'projects', p.relayHost, String(p.relayPort), p.hostId, anchor, grantedCertPem, key, ''], { timeout: 30_000, maxBuffer: 1 << 20 })
  console.log(`[syn]   projects -> ${stdout.trim().replace(/\n/g, ' | ')}`)
  projectPath = (stdout.match(/^project (.+)$/m) || [])[1]
  if (!projectPath) { console.log('[syn] ✗ no authorized project'); process.exit(2) }
} catch (e) { console.log(`[syn] ✗ projects failed: ${e.message}`); process.exit(2) }

// Provider picker op: the device learns which Providers the host offers.
console.log('[syn] relay-run providers...')
try {
  const { stdout } = await exec(probe, ['relay-run', 'providers', p.relayHost, String(p.relayPort), p.hostId, anchor, grantedCertPem, key, ''], { timeout: 30_000, maxBuffer: 1 << 20 })
  console.log(`[syn]   providers -> ${stdout.trim().replace(/\n/g, ' | ')}`)
} catch (e) { console.log(`[syn]   (providers op error: ${e.message})`) }

// Session catalog op: the device learns the SAME conversations the Mac lists
// (fixes the always-empty phone session list).
console.log('[syn] relay-run sessions...')
try {
  const { stdout } = await exec(probe, ['relay-run', 'sessions', p.relayHost, String(p.relayPort), p.hostId, anchor, grantedCertPem, key, ''], { timeout: 30_000, maxBuffer: 1 << 20 })
  console.log(`[syn]   sessions -> ${stdout.trim().replace(/\n/g, ' | ')}`)
} catch (e) { console.log(`[syn]   (sessions op error: ${e.message})`) }

// THE REAL E2E: submit a qoder task, poll the ledger to a terminal state, then
// drain the streamed output. providerId is 'qoder' (the fix the phone needs too).
const prompt = process.env.SCRY_PROMPT || '读取 greet.js 后用一句话说明它做什么，不要修改任何文件。'
const detailPath = join(dir, 'routing.json')
writeFileSync(detailPath, JSON.stringify({ cwd: projectPath, providerId: 'qoder', agentProfileId: null, prompt }), { mode: 0o600 })
console.log(`[syn] relay-run submit (qoder, cwd=${projectPath})...`)
let runId
try {
  const { stdout } = await exec(probe, ['relay-run', 'submit', p.relayHost, String(p.relayPort), p.hostId, anchor, grantedCertPem, key, detailPath], { timeout: 30_000, maxBuffer: 1 << 20 })
  runId = (stdout.match(/^submit (\S+)/m) || [])[1]
  console.log(`[syn]   -> ${stdout.trim()}`)
  if (!runId) { console.log('[syn] ✗ no runId'); process.exit(2) }
} catch (e) { console.log(`[syn] ✗ submit failed: ${e.message}`); process.exit(2) }

console.log('[syn] polling ledger to terminal state (real qoder is running)...')
let terminal = false
for (let i = 0; i < 120 && !terminal; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  try {
    const { stdout } = await exec(probe, ['relay-run', 'state', p.relayHost, String(p.relayPort), p.hostId, anchor, grantedCertPem, key, runId], { timeout: 30_000, maxBuffer: 1 << 20 })
    const st = (stdout.match(/^state (\S+)/m) || [])[1]
    if (['settled', 'failed', 'cancelled'].includes(st)) { console.log(`[syn]   lifecycle=${st}`); terminal = true }
    else if (i % 5 === 0) console.log(`[syn]   lifecycle=${st}...`)
  } catch (e) { if (i % 5 === 0) console.log(`[syn]   (transient poll error: ${e.message})`) }
}
if (!terminal) { console.log('[syn] ✗ run did not reach terminal in time'); process.exit(2) }

console.log('[syn] draining streamed output...')
try {
  const { stdout } = await exec(probe, ['relay-run', 'output', p.relayHost, String(p.relayPort), p.hostId, anchor, grantedCertPem, key, runId, '0'], { timeout: 30_000, maxBuffer: 1 << 20 })
  const lines = stdout.trim().split('\n')
  const kinds = {}
  for (const l of lines) { const m = l.match(/^output (\S+) (.*)$/s); if (m) { kinds[m[1]] = (kinds[m[1]] || 0) + 1 } }
  console.log('[syn]   output kinds:', JSON.stringify(kinds))
  for (const l of lines) { const m = l.match(/^output (\S+) (.*)$/s); if (m && (m[1] === 'output' || m[1] === 'reasoning' || m[1] === 'tool' || m[1] === 'tool_result')) console.log(`[syn]   «${m[1]}» ${m[2].slice(0, 160).replace(/\n/g, ' ')}`) }
  console.log('[syn] ✅ FULL AUTOMATED E2E OK: pair -> submit -> REAL qoder -> lifecycle terminal -> streamed output.')
} catch (e) { console.log(`[syn] ✗ output drain failed: ${e.message}`); process.exit(2) }
