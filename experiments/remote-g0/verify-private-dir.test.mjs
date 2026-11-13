import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensurePrivateDir, UnsafePathError } from './verify/private-dir.mjs'

// realpath: macOS tmpdir() sits behind root's /var symlink; the walk follows
// that, and the assertions compare resolved paths.
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'scry-private-dir-')))
const cli = fileURLToPath(new URL('./verify/private-dir.mjs', import.meta.url))

test('creates missing levels mode 700 and accepts the tree', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'results', 'stamp', 'raw')
  assert.equal(ensurePrivateDir(dir), dir)
  for (const level of ['results', 'results/stamp', 'results/stamp/raw']) {
    assert.equal(statSync(join(root, level)).mode & 0o777, 0o700, level)
  }
  assert.equal(ensurePrivateDir(dir), dir, 'idempotent')
})

test('refuses a symlinked results directory', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'elsewhere'))
  symlinkSync(join(root, 'elsewhere'), join(root, 'results'))
  assert.throws(() => ensurePrivateDir(join(root, 'results')), UnsafePathError)
})

// As root every symlink is root's own, which the walk trusts like /tmp; the
// refusal is observable only from an ordinary account (as on CI).
test('refuses a symlinked ancestor of the build directory', { skip: process.getuid() === 0 && 'running as root' }, (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'real', 'raw'), { recursive: true })
  symlinkSync(join(root, 'real'), join(root, 'results'))
  assert.throws(() => ensurePrivateDir(join(root, 'results', 'raw', 'ios-build')), /symlink/)
})

test('refuses . and .. instead of trimming them from the text', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  // Lexically `link/../run` is `<root>/run`; the kernel follows `link` first
  // and lands in the parent of wherever it points.
  mkdirSync(join(root, 'elsewhere', 'deep'), { recursive: true })
  symlinkSync(join(root, 'elsewhere', 'deep'), join(root, 'link'))
  assert.throws(() => ensurePrivateDir(`${root}/link/../run`), /contains \. or \.\. components/)
  assert.throws(() => ensurePrivateDir(`${root}/./run`), /contains \. or \.\. components/)
  assert.throws(() => ensurePrivateDir('../run'), /contains \. or \.\. components/)
  assert.ok(!existsSync(join(root, 'run')) && !existsSync(join(root, 'elsewhere', 'run')), 'nothing created')
})

test('refuses an ancestor other accounts can write, sticky or not, unless root owns it', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const shared = join(root, 'shared')
  mkdirSync(shared)
  chmodSync(shared, 0o777)
  assert.throws(() => ensurePrivateDir(join(shared, 'results', 'raw')), /writable by other accounts/)
  chmodSync(shared, 0o1777)
  // Only root's sticky directories (/tmp) are trusted; one owned by an
  // ordinary account is not, nor is it when this process runs as root.
  if (process.getuid() !== 0) {
    assert.throws(() => ensurePrivateDir(join(shared, 'results', 'raw')), /writable by other accounts/)
  }
  chmodSync(shared, 0o775)
  assert.throws(() => ensurePrivateDir(join(shared, 'results')), /writable by other accounts/)
})

test('refuses a results directory that is not this account\'s own', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'results')
  mkdirSync(dir)
  const owner = statSync(dir).uid
  // Checked as another account: the tree is then someone else's.
  assert.throws(() => ensurePrivateDir(dir, { uid: owner + 4242 }), /owned by uid/)
})

test('refuses a group-writable results directory without changing it', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'results')
  mkdirSync(dir)
  chmodSync(dir, 0o770)
  assert.throws(() => ensurePrivateDir(dir, { mode: 0o700 }), /writable by other accounts/)
  assert.equal(statSync(dir).mode & 0o777, 0o770)
})

test('the command line applies --mode and exits non-zero on refusal', (t) => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const build = join(root, 'raw', 'ios-build')
  mkdirSync(build, { recursive: true, mode: 0o755 })
  chmodSync(build, 0o755)
  const ok = spawnSync(process.execPath, [cli, '--mode', '700', build], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(statSync(build).mode & 0o777, 0o700)
  symlinkSync(build, join(root, 'link'))
  const refused = spawnSync(process.execPath, [cli, join(root, 'link')], { encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /refusing results directory: .*symlink/)
})
