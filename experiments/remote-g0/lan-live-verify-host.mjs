// Live REAL-DEVICE verification host over the LAN relay. Stands up the PRODUCTION
// host stack (host identity + HostController + PairingTransport + InnerMtlsHost)
// and dials warm PAIR + RUN legs to the local wrangler relay, then shows a
// scannable `scry1:` code (relayTLS=plaintext, LAN IP). A real iPhone scans it,
// proves possession over inner TLS 1.3 mTLS, and this process auto-confirms
// (acting as the Mac operator — the human anti-MITM step is deliberately NOT
// what this run verifies). The phone then persists the connection and can:
//   - list the host-authorized projects (the `projects` op),
//   - submit a durable intent -> recorded -> dispatched -> settled, and
//   - stream the run's real output content (the `output` channel).
//
// Everything except startRun/listProjects is the real module; startRun is a
// zero-cost STUB (no Provider is spawned), so this spends ZERO tokens while
// exercising the entire device-facing wire + the new SwiftUI UI end-to-end.
//
//   node --import ./ts-relative-resolve.mjs lan-live-verify-host.mjs
import 'reflect-metadata'
import { mkdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { InnerMtlsHost } from '../../src/main/remote/inner-mtls-host.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnectWS } from '../../src/main/remote/relay-connect-ws.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'

cryptoProvider.set(webcrypto)

const relayHost = process.env.SCRY_LAN_HOST || '192.168.0.101'
const relayPort = Number(process.env.SCRY_LAN_PORT || '8799')
const token = process.env.SCRY_LAN_TOKEN || 'local-dev-token'
const relayUrl = `ws://${relayHost}:${relayPort}`

// The host-authorized project directories offered to the phone. Two fixed dirs
// prove the picker + submit routing; a real Mac uses knownProjectDirectories().
const PROJECTS = [
  { path: '/Users/demo/Projects/storefront', label: 'storefront' },
  { path: '/Users/demo/Projects/scry-docs', label: 'scry-docs' }
]
const AUTHORIZED = new Set(PROJECTS.map((p) => p.path))

const stateDir = '/tmp/scry-lan-verify'
mkdirSync(stateDir, { recursive: true })
const identity = await ensureHostIdentity(stateDir + '/identity')
const hostId = identity.hostId

const started = []
const binding = createHostController({
  stateDirectory: stateDir, hostId, anchorSHA256: identity.anchorSHA256,
  verifyCSR: identity.verifyCSR, issue: identity.issue,
  authorizeWorkspace: (cwd) => {
    if (AUTHORIZED.has(cwd)) return cwd
    const e = new Error('workspace_not_authorized'); e.code = 'workspace_not_authorized'; throw e
  },
  // Zero-cost stub: NO Provider is spawned. It streams real output CONTENT on
  // the output channel and settles, so the phone renders the whole lifecycle.
  startRun: async ({ runId, routing, progress, output }) => {
    started.push({ runId, cwd: routing.cwd, prompt: routing.prompt })
    console.log(`[host] ▶ run ${runId.slice(0, 8)}… cwd=${routing.cwd} prompt=${JSON.stringify(routing.prompt).slice(0, 60)}`)
    progress('lan:ack')
    output({ kind: 'output', text: `已收到你的任务（这是零成本验证桩，未真正调用 Provider）。\n目标目录：${routing.cwd}` })
    output({ kind: 'reasoning', text: '演示：这条是“思考”通道的内容。' })
    output({ kind: 'tool', text: 'Edit storefront/app.tsx' })
    output({ kind: 'tool_result', text: 'demo: 1 file changed (+3 -1)' })
    output({ kind: 'output', text: '完成。真实运行需接入 Provider 并获授权花费 token。' })
  },
  gate: new ProviderOperationGate(),
  listProjects: () => PROJECTS
})

const server = await identity.issueHostServer()
const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
const runHost = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })

const pairLeg = createRelayConnectWS({ hostId, url: relayUrl, token, mode: 'pair' })
const runLeg = createRelayConnectWS({ hostId, url: relayUrl, token, mode: 'run' })
const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: pairLeg.connect, readyEvent: pairLeg.readyEvent, poolSize: 4 }) })
const runClient = new RelayClient({ host: runHost, transport: new ReverseTunnelTransport({ connect: runLeg.connect, readyEvent: runLeg.readyEvent, poolSize: 4 }) })
await pairClient.start()
await runClient.start()
console.log(`[host] identity ready hostId=${hostId} anchor=${identity.anchorSHA256.slice(0, 16)}… relay=${relayUrl}`)
await new Promise((r) => setTimeout(r, 1500))

function encodeCode(pair) {
  const payload = { relayHost, relayPort, relayTLS: 'plaintext', hostId, pairingId: pair.pairingId, secret: pair.secret, anchorPEM: identity.caCertificatePEM }
  return 'scry1:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}
function showQR(code) {
  const png = '/tmp/scry-lan-pair-qr.png'
  try { execFileSync('qrencode', ['-o', png, '-s', '8', '-m', '3', code]); spawn('open', [png], { detach: true, stdio: 'ignore' }).unref(); console.log(`[host] QR opened: ${png}`) }
  catch { console.log('[host] qrencode unavailable; use the code string below') }
  console.log(`[host] code: ${code}`)
}

let current = await binding.controller.authority.begin()
showQR(encodeCode(current))
console.log('[host] SCAN NOW with the iPhone (code valid ~2 min). Waiting for the phone to prove…')

const confirmed = new Set()
let lastRegen = Date.now()
let granted = false
let lastRunCount = 0
// Serve indefinitely until killed (Ctrl-C / kill). A fixed window is wrong for
// interactive verification: the phone may submit long after pairing.
while (true) {
  const state = binding.controller.authority.inspectLocal()
  for (const p of state.pairings) {
    if (p.state === 'awaiting_local_confirmation' && !confirmed.has(p.pairingId)) {
      confirmed.add(p.pairingId)
      const fp = p.proof.publicKeySHA256
      console.log(`[host] device PROVED possession: label="${p.proof.deviceLabel}" fp=${fp.slice(0, 16).toUpperCase()}…`)
      try {
        const grant = await binding.controller.authority.confirmLocal(p.pairingId, fp)
        console.log(`[host] ✅ GRANTED deviceId=${grant.deviceId}`)
        granted = true
      } catch (e) { console.log(`[host] confirm failed: ${e}`) }
    }
  }
  // Once granted we simply keep the legs up; the phone drives projects/submit/
  // output over the run channel and each stub run is logged in startRun above.
  if (started.length !== lastRunCount) { lastRunCount = started.length; console.log(`[host] runs observed: ${started.length}`) }
  if (Date.now() - lastRegen > 100_000 && confirmed.size === 0 && !granted) {
    current = await binding.controller.authority.begin()
    lastRegen = Date.now()
    showQR(encodeCode(current))
    console.log('[host] code refreshed (previous expired).')
  }
  await new Promise((r) => setTimeout(r, 1000))
}

// Unreachable in normal operation (killed by signal); kept for lint clarity.
process.on('SIGINT', async () => {
  console.log(`[host] shutting down. runs observed: ${started.length}`)
  try { await pairClient.close() } catch {}
  try { await runClient.close() } catch {}
  try { binding.close() } catch {}
  process.exit(0)
})
