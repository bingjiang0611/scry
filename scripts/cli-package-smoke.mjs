import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(repoRoot, 'packages', 'turn-recorder-cli')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'scry-cli-package-smoke-'))
const installRoot = join(temporaryRoot, 'install')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const run = (file, args, options = {}) => execFileSync(file, args, {
  cwd: repoRoot,
  encoding: 'utf8',
  timeout: 60_000,
  ...options
})

try {
  mkdirSync(installRoot)
  writeFileSync(join(installRoot, 'package.json'), '{"private":true}\n')

  const packed = JSON.parse(run(npm, [
    'pack', packageRoot,
    '--ignore-scripts',
    '--json',
    '--pack-destination', temporaryRoot
  ]))
  assert.equal(packed.length, 1, 'npm pack should create exactly one tarball')
  const tarball = join(temporaryRoot, packed[0].filename)
  assert.ok(existsSync(tarball), `missing npm tarball: ${tarball}`)

  run(npm, [
    'install', tarball,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-package-lock'
  ], { cwd: installRoot })

  const installedRoot = join(installRoot, 'node_modules', '@ali', 'scry-turn-recorder')
  const bin = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'scry.cmd' : 'scry')
  accessSync(bin, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  assert.ok(existsSync(join(installedRoot, 'dist', 'cli', 'scry.js')), 'tarball is missing the built CLI')
  assert.ok(existsSync(join(installedRoot, 'integrations', 'pi-scry-recorder.mjs')), 'tarball is missing the Pi integration')
  assert.equal(existsSync(join(installedRoot, 'src')), false, 'tarball must not contain TypeScript sources')

  const version = run(bin, ['--version'], { cwd: installRoot }).trim()
  assert.equal(version, packageJson.version, 'installed bin version must match package.json')
  assert.match(run(bin, ['--help'], { cwd: installRoot }), /^Usage:/m)

  const workspace = join(temporaryRoot, 'workspace')
  mkdirSync(workspace)
  run('git', ['init', '-q'], { cwd: workspace })
  const initOutput = run(bin, ['init', '--providers', 'claude,codex,qoder,opencode'], { cwd: workspace })
  assert.match(initOutput, /Scry 已初始化/)
  assert.ok(existsSync(join(workspace, 'scry.config.json')), 'init should create recorder config')
  assert.ok(existsSync(join(workspace, '.scry', 'provider-hook.sh')), 'init should create provider bridge')
  assert.ok(existsSync(join(workspace, '.opencode', 'plugins', 'scry-recorder.js')), 'init should create OpenCode plugin')
  const codexHooks = readFileSync(join(workspace, '.codex', 'hooks.json'), 'utf8')
  assert.equal((codexHooks.match(/codex UserPromptSubmit/g) ?? []).length, 1, 'init should add one Codex prompt hook')
  run(bin, ['init', '--providers', 'claude,codex,qoder,opencode'], { cwd: workspace })
  assert.equal((readFileSync(join(workspace, '.codex', 'hooks.json'), 'utf8').match(/codex UserPromptSubmit/g) ?? []).length, 1, 'init should be idempotent')

  const doctor = JSON.parse(run(bin, ['doctor', '--workspace', workspace], { cwd: installRoot }))
  assert.equal(doctor.healthy, true, 'fresh installed CLI should pass doctor')

  const hook = join(workspace, '.scry', 'provider-hook.sh')
  run(hook, ['claude', 'UserPromptSubmit'], {
    cwd: workspace,
    input: JSON.stringify({ session_id: 'package-smoke', prompt: 'record this turn', cwd: workspace })
  })
  try {
    let daemon
    const deadline = Date.now() + 30_000
    do {
      daemon = JSON.parse(run(bin, ['recorder', 'status', '--workspace', workspace], { cwd: installRoot }))
      if (!daemon.running) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    } while (!daemon.running && Date.now() < deadline)
    assert.equal(daemon.running, true, 'first direct hook should start the workspace daemon')

    run(hook, ['claude', 'Stop'], {
      cwd: workspace,
      input: JSON.stringify({ session_id: 'package-smoke', assistant_response: 'done', cwd: workspace })
    })
    const records = JSON.parse(run(bin, ['turns', 'list', '--workspace', workspace], { cwd: installRoot }))
    assert.equal(records.length, 1, 'initialized provider bridge should write one completed turn')
    assert.equal(records[0].status, 'completed')
  } finally {
    run(bin, ['recorder', 'stop', '--workspace', workspace], { cwd: installRoot })
  }

  process.stdout.write(`${JSON.stringify({ package: packageJson.name, version, bin: 'ok', init: 'idempotent', hook: 'recorded', doctor: 'healthy' })}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
