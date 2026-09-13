// Live pairing host for a REAL iPhone scan. Stands up the production host stack
// (host identity + HostController + PairingTransport) and dials a warm PAIR leg
// to the DEPLOYED Cloudflare relay, then prints + shows (via qrencode) the
// scannable `scry1:` code. When the phone proves possession over inner TLS 1.3
// mTLS, it prints the proved fingerprint and confirms locally (this process acts
// as the Mac operator), completing a real grant.
//
// Sandbox note: this machine's egress is forced through an HTTP proxy and the
// WHATWG global WebSocket does not traverse it, so the warm leg uses undici's
// WebSocket with an explicit ProxyAgent dispatcher. A real Mac with direct
// internet uses the production createRelayConnectWS (global WebSocket) instead;
// this harness swaps ONLY the leaf socket, reusing the real host/pairing stack.
//
//   SCRY_CF_URL=wss://scry-relay.<sub>.workers.dev SCRY_CF_TOKEN=<token> \
//   node --import ./ts-relative-resolve.mjs cf-live-pair-host.mjs
import 'reflect-metadata'
import { Duplex } from 'node:stream'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { WebSocket, ProxyAgent } from 'undici'
import { ensureHostIdentity } from '../../src/main/remote/host-identity.ts'
import { createHostController } from '../../src/main/remote/host-controller-factory.ts'
import { PairingTransport } from '../../src/main/remote/pairing-transport.ts'
import { RelayClient, ReverseTunnelTransport } from '../../src/main/remote/relay-client.ts'
import { ProviderOperationGate } from '../../src/main/provider-operation-gate.ts'

cryptoProvider.set(webcrypto)

const url = process.env.SCRY_CF_URL
const token = process.env.SCRY_CF_TOKEN
if (!url || !token) { console.error('set SCRY_CF_URL and SCRY_CF_TOKEN'); process.exit(2) }
const proxy = process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.https_proxy
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
const endpoint = new URL(url)
const relayHost = endpoint.hostname
const relayPort = endpoint.port ? Number(endpoint.port) : 443

// Proxied outbound WS leg: mirrors src/main/remote/relay-connect-ws.ts wsLeg but
// through undici + ProxyAgent so the sandbox can reach the public edge.
function proxiedLeg(mode) {
  const base = url.replace(/\/+$/, '')
  const ws = new WebSocket(`${base}/host?host=${encodeURIComponent(hostId)}&mode=${mode}`, dispatcher ? { dispatcher } : undefined)
  ws.binaryType = 'arraybuffer'
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) { try { ws.send(chunk); cb() } catch (e) { cb(e) } },
    final(cb) { try { ws.close(1000) } catch {} cb() },
    destroy(err, cb) { try { ws.close() } catch {} cb(err) }
  })
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ token })); duplex.emit('connect') })
  ws.addEventListener('message', (ev) => {
    const d = ev.data
    duplex.push(typeof d === 'string' ? Buffer.from(d) : Buffer.from(d))
  })
  ws.addEventListener('close', () => { duplex.push(null); if (!duplex.destroyed) duplex.destroy() })
  ws.addEventListener('error', () => { if (!duplex.destroyed) duplex.destroy(new Error('relay_ws_error')) })
  return duplex
}

const stateDir = '/tmp/scry-live-host'
mkdirSync(stateDir, { recursive: true })
const identity = await ensureHostIdentity(stateDir + '/identity')
const hostId = identity.hostId
const binding = createHostController({
  stateDirectory: stateDir, hostId, anchorSHA256: identity.anchorSHA256,
  verifyCSR: identity.verifyCSR, issue: identity.issue,
  authorizeWorkspace: (cwd) => cwd, startRun: async () => {}, gate: new ProviderOperationGate()
})
const server = await identity.issueHostServer()
const pairingTransport = new PairingTransport({ authority: binding.controller.authority, serverCertPEM: server.certificatePEM, serverKeyPEM: server.privateKeyPEM })
const pairClient = new RelayClient({ host: pairingTransport, transport: new ReverseTunnelTransport({ connect: () => proxiedLeg('pair'), readyEvent: 'connect', poolSize: 8 }) })
await pairClient.start()
console.log(`[host] identity ready hostId=${hostId} anchor=${identity.anchorSHA256.slice(0, 16)}…`)
await new Promise((r) => setTimeout(r, 2500)) // warm legs register with the DO over the internet

function encodeCode(pair) {
  const payload = { relayHost, relayPort, relayTLS: 'system', hostId, pairingId: pair.pairingId, secret: pair.secret, anchorPEM: identity.caCertificatePEM }
  return 'scry1:' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function showQR(code) {
  const png = '/tmp/scry-pair-qr.png'
  execFileSync('qrencode', ['-o', png, '-s', '8', '-m', '3', code])
  spawn('open', [png], { detach: true, stdio: 'ignore' }).unref()
  console.log(`[host] QR opened in Preview: ${png}`)
  console.log(`[host] code: ${code}`)
}

let current = await binding.controller.authority.begin()
showQR(encodeCode(current))
console.log(`[host] SCAN NOW — code valid ~2 min. Waiting for the phone to prove…`)

const confirmed = new Set()
const deadline = Date.now() + 6 * 60_000
let lastRegen = Date.now()
while (Date.now() < deadline) {
  const state = binding.controller.authority.inspectLocal()
  for (const p of state.pairings) {
    if (p.state === 'awaiting_local_confirmation' && !confirmed.has(p.pairingId)) {
      confirmed.add(p.pairingId)
      const fp = p.proof.publicKeySHA256
      console.log(`[host] device PROVED possession: label="${p.proof.deviceLabel}" fingerprint=${fp.slice(0, 16).toUpperCase()}…`)
      console.log(`[host] confirming (acting as the Mac operator)…`)
      try {
        const grant = await binding.controller.authority.confirmLocal(p.pairingId, fp)
        console.log(`[host] ✅ GRANTED deviceId=${grant.deviceId} expiresAt=${new Date(grant.expiresAt).toISOString()}`)
      } catch (e) { console.log(`[host] confirm failed: ${e}`) }
    }
  }
  if (state.grants.some((g) => g.revokedAt === null)) {
    console.log(`[host] pairing complete — a live grant exists. Leaving the leg up 10s for the phone's grant fetch…`)
    await new Promise((r) => setTimeout(r, 10_000))
    break
  }
  // Refresh the code before its ~2 min TTL if nobody has proved yet.
  if (Date.now() - lastRegen > 100_000 && confirmed.size === 0) {
    current = await binding.controller.authority.begin()
    lastRegen = Date.now()
    showQR(encodeCode(current))
    console.log('[host] code refreshed (previous expired).')
  }
  await new Promise((r) => setTimeout(r, 1000))
}

console.log('[host] shutting down.')
try { await pairClient.close() } catch {}
try { binding.close() } catch {}
process.exit(0)
