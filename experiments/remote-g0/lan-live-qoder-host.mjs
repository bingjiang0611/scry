// REAL-PROVIDER real-device verification host over the LAN relay. Identical wire
// to production index.ts startRemoteHostIfEnabled, but self-driven so it can run
// without clicking the Electron renderer:
//   - production host stack: identity + HostController + PairingTransport +
//     InnerMtlsHost, reusing the SAME state dir (identity + existing grant) so a
//     previously-paired phone stays paired (no re-scan),
//   - the REAL run seam: createRemoteRunBinding + the REAL ProviderRegistry, so a
//     routed device intent becomes a REAL qoder run that SPENDS TOKENS,
//   - qoder pinned to permissionMode 'full_access' (bypassPermissions) because the
//     operator explicitly granted qoder maximum authorization for this session.
//
// The operator confirm is auto-granted here (the human anti-MITM confirm is not
// what this exercises); everything else — transport, mTLS, gateway, dispatcher,
// gated executor, the qoder run and its streamed output — is the real path.
//
//   node --import ./ts-relative-resolve.mjs lan-live-qoder-host.mjs
import 'reflect-metadata'
import { homedir } from 'node:os'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { createRemoteRunBinding } from '../../src/main/remote/remote-run-binding.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { InnerMtlsHost } from '../../src/main/remote/inner-mtls-host.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { createRelayConnectWS } from '../../src/main/remote/relay-connect-ws.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'
import { ProviderRegistry } from '../../src/main/providers/registry.ts'
import { createBuiltInProviderAdapters } from '../../src/main/providers/index.ts'

cryptoProvider.set(webcrypto)

const relayHost = process.env.SCRY_LAN_HOST || '192.168.0.101'
const relayPort = Number(process.env.SCRY_LAN_PORT || '8799')
const token = process.env.SCRY_LAN_TOKEN || 'local-dev-token'
const relayUrl = `ws://${relayHost}:${relayPort}`

// The single REAL project directory qoder may work in. Canonicalized so the
// path offered to the phone == the path the workspace authorizer accepts ==
// qoder's cwd (macOS /tmp -> /private/tmp).
const PROJECT = realpathSync(process.env.SCRY_LIVE_PROJECT || '/tmp/scry-live-project')
const PROJECTS = [{ path: PROJECT, label: 'scry-live-project' }]

// The REAL provider registry, built exactly like index.ts (paths only, no
// Electron). qoder resolves its auth under the real home (~/.qoder).
const home = homedir()
const scratch = mkdtempSync(join(tmpdir(), 'scry-qoder-adapters-'))
const adapters = createBuiltInProviderAdapters(
  home, join(scratch, 'codex-home'), join(scratch, 'oc-auth'), join(scratch, 'oc-state')
)
const providerRegistry = new ProviderRegistry(adapters, { disabledProviders: new Set(), runControlsEnabled: true })

// Cached provider snapshot for the device picker, mirroring index.ts.
let providerSnapshot = []
async function refreshProviders() {
  try { const d = await providerRegistry.describe(); providerSnapshot = d.map((x) => ({ id: x.id, label: x.label, available: x.available })) } catch {}
}
await refreshProviders()
setInterval(() => { void refreshProviders() }, 15_000)
console.log(`[host] providers: ${providerSnapshot.map((x) => x.id + (x.available ? '' : '(x)')).join(', ')}`)

// Same wire as production, with ONE explicit operator decision: qoder runs in
// full_access (bypassPermissions) so it never blocks on an approval the remote
// path cannot yet route. This is the operator's stated max-authorization grant.
const startRun = createRemoteRunBinding({
  run: (providerId, request) => providerRegistry.run(providerId, { ...request, permissionMode: 'full_access' })
})

const stateDir = process.env.SCRY_LIVE_STATE || '/tmp/scry-lan-verify'
mkdirSync(stateDir, { recursive: true })
const identity = await ensureHostIdentity(stateDir + '/identity')
const hostId = identity.hostId

const started = []
const binding = createHostController({
  stateDirectory: stateDir, hostId, anchorSHA256: identity.anchorSHA256,
  verifyCSR: identity.verifyCSR, issue: identity.issue,
  authorizeWorkspace: (cwd) => {
    let canonical
    try { canonical = realpathSync(cwd) } catch { canonical = cwd }
    if (canonical === PROJECT) return canonical
    const e = new Error('workspace_not_authorized'); e.code = 'workspace_not_authorized'; throw e
  },
  startRun: async (input) => {
    started.push({ runId: input.runId, cwd: input.routing.cwd, prompt: input.routing.prompt })
    console.log(`[host] ▶ REAL qoder run ${input.runId.slice(0, 8)}… cwd=${input.routing.cwd}`)
    console.log(`[host]   prompt=${JSON.stringify(input.routing.prompt).slice(0, 120)}`)
    // Mirror the assistant's streamed content to the host console too, so the
    // verifier can see qoder's real output alongside the phone.
    const wrapped = { ...input, output: (chunk) => {
      const t = chunk.text.length > 160 ? chunk.text.slice(0, 160) + '…' : chunk.text
      console.log(`[host]   «${chunk.kind}» ${t.replace(/\n/g, ' ')}`)
      input.output(chunk)
    } }
    try { await startRun(wrapped); console.log(`[host] ✓ qoder run ${input.runId.slice(0, 8)}… settled`) }
    catch (e) { console.log(`[host] ✗ qoder run ${input.runId.slice(0, 8)}… failed: ${e?.message || e}`); throw e }
  },
  gate: new ProviderOperationGate(),
  listProjects: () => { console.log(`[host] ← listProjects requested (returning ${PROJECTS.length})`); return PROJECTS },
  listProviders: () => { console.log(`[host] ← listProviders requested (${providerSnapshot.length})`); return providerSnapshot }
})
process.on('unhandledRejection', (e) => console.log(`[host] ⚠ unhandledRejection: ${e?.message || e}`))
process.on('uncaughtException', (e) => console.log(`[host] ⚠ uncaughtException: ${e?.message || e}`))

const server = await identity.issueHostServer()
const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
const runHost = new InnerMtlsHost({ controller: binding.controller, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM, caPEM: identity.caCertificatePEM })
const pairLeg = createRelayConnectWS({ hostId, url: relayUrl, token, mode: 'pair' })
const runLeg = createRelayConnectWS({ hostId, url: relayUrl, token, mode: 'run' })
const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: pairLeg.connect, readyEvent: pairLeg.readyEvent, poolSize: 4 }) })
const runClient = new RelayClient({ host: runHost, transport: new ReverseTunnelTransport({ connect: runLeg.connect, readyEvent: runLeg.readyEvent, poolSize: 4 }) })
await pairClient.start()
await runClient.start()
console.log(`[host] REAL qoder host ready hostId=${hostId} anchor=${identity.anchorSHA256.slice(0, 16)}… relay=${relayUrl}`)
console.log(`[host] authorized project: ${PROJECT}`)
await new Promise((r) => setTimeout(r, 1500))

function encodeCode(pair) {
  const payload = { relayHost, relayPort, relayTLS: 'plaintext', hostId, pairingId: pair.pairingId, secret: pair.secret, anchorPEM: identity.caCertificatePEM }
  return 'scry1:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}
function showQR(code) {
  const png = '/tmp/scry-lan-pair-qr.png'
  try { execFileSync('qrencode', ['-o', png, '-s', '8', '-m', '3', code]); spawn('open', [png], { detach: true, stdio: 'ignore' }).unref(); console.log(`[host] QR opened: ${png}`) }
  catch { /* qrencode optional */ }
  console.log(`[host] code: ${code}`)
}

// Always offer a fresh pairing code. A prior grant (from an earlier partial
// pairing) can carry a device key/cert that no longer matches, which fails the
// run channel's strict mTLS with a silent handshake hang-up. Re-scanning mints a
// fresh matching keypair+cert pinned to the current anchor and is exactly the
// QR-pairing leg we want to validate end to end.
const existing = binding.controller.authority.inspectLocal().grants.filter((g) => g.revokedAt === null)
if (existing.length > 0) console.log(`[host] ${existing.length} prior grant(s) present; offering a FRESH scan anyway (prior creds may be stale).`)
let granted = false
const current = await binding.controller.authority.begin()
showQR(encodeCode(current))
console.log('[host] SCAN NOW with the iPhone (code valid ~2 min).')

let lastRunCount = 0
let lastRegen = Date.now()
let lastCode = null
process.on('SIGINT', async () => {
  console.log(`[host] shutting down. real qoder runs observed: ${started.length}`)
  try { await pairClient.close() } catch {}
  try { await runClient.close() } catch {}
  try { binding.close() } catch {}
  process.exit(0)
})

while (true) {
  const state = binding.controller.authority.inspectLocal()
  for (const p of state.pairings) {
    if (p.state === 'awaiting_local_confirmation' && p.proof) {
      const fp = p.proof.publicKeySHA256
      try {
        const grant = await binding.controller.authority.confirmLocal(p.pairingId, fp)
        console.log(`[host] ✅ GRANTED deviceId=${grant.deviceId} (auto-confirmed operator step)`) 
        granted = true
      } catch { /* already handled */ }
    }
  }
  if (started.length !== lastRunCount) { lastRunCount = started.length }
  if (!granted && Date.now() - lastRegen > 100_000) {
    const current = await binding.controller.authority.begin()
    lastCode = encodeCode(current); showQR(lastCode); lastRegen = Date.now()
    console.log('[host] code refreshed (previous expired).')
  }
  await new Promise((r) => setTimeout(r, 1000))
}
