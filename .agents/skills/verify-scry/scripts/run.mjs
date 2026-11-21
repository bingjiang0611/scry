#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { freePort, waitForTarget, connectCdp, rendererEvaluator } from '../../../../scripts/electron-security-cdp.mjs'
import { electronDevLayout } from '../../../../scripts/packaged-app-layout.mjs'
import { stopOwnedApp } from '../../../../scripts/owned-app-processes.mjs'
import { exerciseSourceControlApp } from '../../../../scripts/source-control-ui-checks.mjs'
import { doctor, processIdentity, sha256 } from './doctor.mjs'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'))
assert.equal(realpathSync(process.cwd()), root, 'run from the repository root')
assert.ok(process.argv.slice(2).every(arg => arg === '--negative-control'), 'only --negative-control is supported')
const negative = process.argv.includes('--negative-control')
const executable = resolve(root, electronDevLayout().executable)
const main = join(root, 'out/main/index.js')
const renderer = join(root, 'out/renderer/index.html')
const buildFiles = [main, join(root, 'out/preload/index.cjs'), renderer]
for (const path of [executable, ...buildFiles]) assert.ok(existsSync(path), `missing ${path}; follow SKILL.md Launch`)
const evidence = mkdtempSync(join(tmpdir(), 'scry-verification-evidence-'))
console.log(`EVIDENCE=${evidence}`)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scry-verification-scratch-')))
const home = join(scratch, 'home')
const userData = join(scratch, 'user-data')
const workspace = join(home, 'workspace')
const remote = join(scratch, 'remote.git')
const entry = join(scratch, 'entry.mjs')
const record = (name, data) => writeFileSync(join(evidence, name), JSON.stringify(data, null, 2) + '\n')
const event = data => appendFileSync(join(evidence, 'actions.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...data }) + '\n')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SCRY_|GIT_|ELECTRON_|XDG_)/.test(key)))
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'),
  SCRY_TEST_APP: '1', SCRY_DISABLED_PROVIDERS: 'claude,codex,qoder,opencode,pi' })
let child, cdp
const result = { status: 'failed', feature: 'source-control', negativeControl: negative, evidence, scratch }
try {
  mkdirSync(workspace, { recursive: true })
  mkdirSync(userData)
  mkdirSync(remote)
  // Same persisted catalog contract as electron-security-smoke.mjs. No fake run result.
  writeFileSync(join(userData, 'recent-folders.json'), JSON.stringify([realpathSync(workspace), realpathSync(remote)]))
  writeFileSync(join(userData, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'verify-source-control', runId: 'verify-source-control', providerId: 'codex', runtimeProvider: 'codex_cli',
    cwd: workspace, preview: 'verification fixture (no Provider execution)', ts: Date.now()
  }]))
  writeFileSync(entry, `import { app } from 'electron'\n` +
    `import hidden from ${JSON.stringify(pathToFileURL(join(root, 'scripts/hidden-electron-windows.cjs')).href)}\n` +
    `hidden(app)\napp.setPath('userData', ${JSON.stringify(userData)})\nawait import(${JSON.stringify(pathToFileURL(main).href)})\n`)
  const port = await freePort()
  const build = Object.fromEntries(buildFiles.map(path => [path, sha256(path)]))
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  record('checkout.json', { revision, diff: execFileSync('git', ['diff', '--stat'], { cwd: root, encoding: 'utf8' }),
    status: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }), build,
    harness: Object.fromEntries(['.agents/skills/verify-scry/scripts/run.mjs', '.agents/skills/verify-scry/scripts/doctor.mjs',
      'scripts/source-control-ui-checks.mjs'].map(path => [path, sha256(join(root, path))])),
    platform: process.platform, arch: process.arch, node: process.version })
  child = spawn(executable, [entry, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.on('data', chunk => appendFileSync(join(evidence, 'app.stdout.log'), chunk))
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); appendFileSync(join(evidence, 'app.stderr.log'), chunk) })
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject) })
  record('instance.json', { pid: child.pid, identity: processIdentity(child.pid), port, entry, scratch, build, revision,
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, renderer: pathToFileURL(renderer).href })
  const { page } = await waitForTarget(port, () => child, 30000, () => stderr)
  assert.equal(page.url, pathToFileURL(renderer).href)
  cdp = connectCdp(page.webSocketDebuggerUrl)
  const evaluate = rendererEvaluator(cdp)
  const deadline = Date.now() + 15000
  while (!await evaluate(`Boolean(document.querySelector('button.sb-sess'))`)) {
    assert.ok(Date.now() < deadline, 'persisted fixture session never became usable')
    await delay(50)
  }
  record('doctor.json', await doctor(evidence))
  console.log('READY: owned production renderer, preload and fixture session verified')
  const before = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(evidence, 'before.png'), Buffer.from(before.data, 'base64'))
  let screenshot = 0
  // Reuse real native-input journeys; retain dispatched input and screenshots even on failure.
  const observedCdp = { async send(method, params) {
    if (method.startsWith('Input.')) {
      event({ method, params, suppressed: negative && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' })
      if (negative && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') return {}
    }
    const response = await cdp.send(method, params)
    if (method === 'Page.captureScreenshot') {
      writeFileSync(join(evidence, `step-${++screenshot}.png`), Buffer.from(response.data, 'base64'))
    }
    return response
  } }
  const checks = await exerciseSourceControlApp(observedCdp, evaluate, { workspace, remote, home })
  record('checks.json', checks)
  for (const path of checks.captures) copyFileSync(path, join(evidence, basename(path)))
  result.status = 'passed'
} catch (error) {
  result.error = error.stack ?? String(error)
  console.error(result.error)
  process.exitCode = 1
} finally {
  if (cdp) {
    try {
      record('final-dom.json', await rendererEvaluator(cdp)(`({ title: document.title, text: document.body.innerText.slice(0, 20000) })`))
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(evidence, 'final.png'), Buffer.from(shot.data, 'base64'))
    } catch (error) {
      record('capture-error.json', { error: String(error) })
      result.status = 'failed'
      process.exitCode = 1
    }
    cdp.close()
  }
  if (existsSync(join(workspace, '.git'))) {
    try {
      const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', env }).trim()
      record('git.json', { status: git('status', '--porcelain'), log: git('log', '--format=%H %s'), refs: git('show-ref'),
        remotes: git('remote', '-v'), remoteRefs: existsSync(join(scratch, 'remote.git'))
          ? execFileSync('git', ['--git-dir', join(scratch, 'remote.git'), 'show-ref'], { encoding: 'utf8', env }).trim() : null,
        hookRan: existsSync(join(home, 'untrusted-hook-ran')) })
    } catch (error) {
      record('git-capture-error.json', { error: String(error) })
      result.status = 'failed'
      process.exitCode = 1
    }
  }
  try {
    result.cleanup = await stopOwnedApp(child)
    rmSync(scratch, { recursive: true, force: true })
    result.scratchRemoved = !existsSync(scratch)
  } catch (error) {
    result.status = 'failed'
    result.cleanup = { status: 'unknown', error: String(error) }
    process.exitCode = 1
  }
  record('result.json', result)
  console.log(JSON.stringify(result))
  assert.ok(existsSync(join(evidence, 'result.json')), 'cleanup removed evidence')
}
