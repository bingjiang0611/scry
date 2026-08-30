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
  writeFileSync(join(workspace, 'scry.config.json'), `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'cli-package-smoke',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }, null, 2)}\n`)
  const doctor = JSON.parse(run(bin, ['doctor', '--workspace', workspace], { cwd: installRoot }))
  assert.equal(doctor.healthy, true, 'fresh installed CLI should pass doctor')

  process.stdout.write(`${JSON.stringify({ package: packageJson.name, version, bin: 'ok', doctor: 'healthy' })}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
