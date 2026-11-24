import { execFileSync } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { once } from 'node:events'
import { Pkcs10CertificateRequestGenerator } from '@peculiar/x509'
import { createRecentFoldersStore } from '../src/main/app-store'
import { REMOTE_PROTOCOL_VERSION } from '../src/shared/desktop-remote'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function enrollAndCallLaunchdDaemon(repoRoot: string) {
  const uid = String(process.getuid?.() ?? execFileSync('id', ['-u'], { encoding: 'utf8' }).trim())
  const label = 'com.scry.daemon.w8-test'
  const root = mkdtempSync(join('/tmp', 'scry-w8-ld-'))
  const userDataDir = join(root, 'u')
  const stateDir = join(root, 's')
  const workspace = join(root, 'w')
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const canonicalWorkspace = realpathSync(workspace)
  createRecentFoldersStore(userDataDir).push(canonicalWorkspace)

  const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`)
  const electronBin = join(repoRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const daemonEntry = join(repoRoot, 'out/main/daemon.js')
  const stdoutLog = join(root, 'daemon.out.log')
  const stderrLog = join(root, 'daemon.err.log')

  const proxyEntries = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']
    .filter((k) => process.env[k]?.trim())
    .map((k) => `    <key>${k}</key><string>${escapeXml(process.env[k]!.trim())}</string>`)
    .join('\n')

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${electronBin}</string>
    <string>${daemonEntry}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${homedir()}</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>SCRY_EXPERIMENTAL_PROVIDERS</key><string>antigravity</string>
    <key>SCRY_REMOTE_RELAY_ENABLED</key><string>0</string>
    <key>SCRY_DAEMON_STARTED_BY</key><string>launchd-w8-test</string>
    <key>SCRY_DAEMON_STATE_DIR</key><string>${stateDir}</string>
    <key>SCRY_DAEMON_USER_DATA_DIR</key><string>${userDataDir}</string>
    <key>SCRY_DAEMON_APP_PATH</key><string>${repoRoot}</string>
    <key>SCRY_DAEMON_RESOURCES_PATH</key><string>${join(repoRoot, 'resources')}</string>
    <key>SCRY_DAEMON_APP_VERSION</key><string>0.2.250</string>
    <key>SCRY_DAEMON_PACKAGED</key><string>0</string>
${proxyEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${stdoutLog}</string>
  <key>StandardErrorPath</key><string>${stderrLog}</string>
</dict></plist>\n`

  try {
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }) } catch {}
    writeFileSync(plistPath, plist, { mode: 0o600 })
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath])

    const enrollSock = join(stateDir, 'enroll.sock')
    const localSock = join(stateDir, 'local.sock')
    const secretFile = join(stateDir, 'local-enrollment.json')
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !(existsSync(enrollSock) && existsSync(localSock) && existsSync(secretFile))) {
      await new Promise((r) => setTimeout(r, 150))
    }
    if (!existsSync(secretFile)) {
      const errLog = existsSync(stderrLog) ? readFileSync(stderrLog, 'utf8') : ''
      throw new Error(`launchd daemon did not produce enrollment secret within 15s: ${errLog}`)
    }

    const { secret } = JSON.parse(readFileSync(secretFile, 'utf8')) as { secret: string }
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)
    const b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')
    const keyPEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
    const csr = await Pkcs10CertificateRequestGenerator.create({
      name: 'CN=a9-launchd-client',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
    })

    const enrollReply = await new Promise<Record<string, any>>((resolveReq, rejectReq) => {
      const sock = netConnect(enrollSock)
      let buf = ''
      sock.once('error', rejectReq)
      sock.once('connect', () => {
        sock.write(`${JSON.stringify({ version: 1, secret, csrPEM: csr.toString('pem'), deviceLabel: 'a9-test' })}\n`)
      })
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        if (buf.includes('\n')) {
          sock.destroy()
          resolveReq(JSON.parse(buf.split('\n')[0]))
        }
      })
    })
    if (!enrollReply.certificatePEM || !enrollReply.caCertificatePEM) {
      throw new Error(`enrollment failed: ${JSON.stringify(enrollReply)}`)
    }

    const callSock = async (body: Record<string, unknown>) => {
      const raw = netConnect(localSock)
      await once(raw, 'connect')
      const tls = tlsConnect({
        socket: raw,
        ca: enrollReply.caCertificatePEM,
        cert: enrollReply.certificatePEM,
        key: keyPEM,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined
      })
      await once(tls, 'secureConnect')
      tls.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...body })}\n`)
      let buf = ''
      for await (const chunk of tls) {
        buf += (chunk as Buffer).toString('utf8')
        if (buf.includes('\n')) break
      }
      tls.destroy()
      return JSON.parse(buf.split('\n')[0]) as Record<string, any>
    }

    const descriptors = await callSock({ op: 'providerCatalog', method: 'providerDescriptors', args: [] })
    const remoteProviders = await callSock({ op: 'providers', detail: 'metadata' })
    const controls = await callSock({
      op: 'providerCatalog',
      method: 'runControls',
      args: [{ providerId: 'antigravity', cwd: canonicalWorkspace }]
    })

    async function exerciseRun(permissionMode: 'full_access' | 'default', prompt: string) {
      const request = { op: 'subscribe', views: ['activeRuns'] }
      const snapshot = await callSock({ ...request, waitMs: 0 })
      if (snapshot.subscribe?.mode !== 'snapshot') throw new Error(`subscribe snapshot failed: ${JSON.stringify(snapshot)}`)
      const { hostId, logId, seq } = snapshot.subscribe
      let known = { hostId, logId, seq }
      const submitted = await callSock({
        op: 'submit',
        intentId: randomUUID(),
        detail: JSON.stringify({ cwd: canonicalWorkspace, providerId: 'antigravity', permissionMode, prompt })
      })
      let state = 'dispatched'
      const events: Array<{ type: string; payload: { reason?: string } }> = []
      const chunks: unknown[] = []
      if (!submitted.runId) return { submitted, state, events, chunks }
      let outputCursor = 0
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !['settled', 'failed', 'cancelled', 'interrupted'].includes(state)) {
        const reply = await callSock({ ...request, known, waitMs: 5_000 })
        const page = reply.subscribe
        if (!page || page.hostId !== hostId || page.logId !== logId || !Number.isSafeInteger(page.seq) || page.seq < known.seq) {
          throw new Error(`subscribe lost the run cursor: ${JSON.stringify(reply)}`)
        }
        known = { hostId, logId, seq: page.seq }
        const row = page.snapshot?.activeRuns?.rows.find((run: { runId: string }) => run.runId === submitted.runId)
        if (row) state = row.lifecycle
        for (const event of page.events ?? []) {
          if (event.runId !== submitted.runId) continue
          events.push(event)
          if (['run.settled', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) state = event.type.slice(4)
        }
        const output = await callSock({ op: 'output', runId: submitted.runId, cursor: outputCursor })
        if (!output.output || !Array.isArray(output.output.chunks)) throw new Error(`output unavailable: ${JSON.stringify(output)}`)
        outputCursor = output.output.cursor
        chunks.push(...output.output.chunks)
      }
      return { submitted, state, events, chunks }
    }

    const full = await exerciseRun('full_access', 'Reply with exactly: LAUNCHD_A9_OK')
    // D11 uses the explicit user permissions.allow configuration in its manual acceptance environment.
    const standard = await exerciseRun('default', 'Reply with exactly: LAUNCHD_DEFAULT_D11_OK')

    return {
      label,
      hasAntigravityDescriptor: (descriptors.result ?? []).some((d: { id: string }) => d.id === 'antigravity'),
      hasAntigravityRemoteProvider: (remoteProviders.providers ?? []).some((p: { id?: string; providerId?: string }) => (p.providerId ?? p.id) === 'antigravity'),
      runControlsState: controls.result?.state,
      modelCount: controls.result?.data?.models?.length ?? 0,
      nonGeminiTagged: (controls.result?.data?.models ?? []).some((m: { description?: string }) => m.description?.includes('经 Antigravity 提供')),
      fullAccessRun: { status: full.submitted.status, runState: full.state, chunks: full.chunks, eventsCount: full.events.length },
      d11DefaultWithUserRules: {
        status: standard.submitted.status, state: standard.state, chunks: standard.chunks,
        failedDetail: standard.events.find((event) => event.type === 'run.failed')?.payload.reason
      }
    }
  } finally {
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }) } catch {}
    rmSync(plistPath, { force: true })
    rmSync(root, { recursive: true, force: true })
  }
}
