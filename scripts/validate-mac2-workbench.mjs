import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Opt-in real-machine acceptance. It never replaces an installed app, stops an
// existing Scry, uses real Provider credentials, or writes a user's workspace.
const target = process.argv.find(arg => arg.startsWith('--host='))?.slice(7)
if (!target || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Usage: node scripts/validate-mac2-workbench.mjs --host=user@hostname')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const app = join(root, 'dist/mac-arm64/Scry.app')
const asar = join(app, 'Contents/Resources/app.asar')
if (!existsSync(asar)) throw new Error('Run npm run pack:artifact before real-machine acceptance')
const temp = mkdtempSync(join(tmpdir(), 'scry-mac2-workbench-'))
const ssh = (...args) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const remote = ssh('mktemp -d "$HOME/scry-workbench-validation.XXXXXX"').trim()
if (!/^\/Users\/[A-Za-z0-9_.-]+\/scry-workbench-validation\.[A-Za-z0-9]+$/.test(remote)) throw new Error('Unexpected remote temporary directory')
const bundle = join(temp, 'desktop-transport-client.mjs')
await build({ entryPoints: [join(root, 'src/main/remote/desktop-transport.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'bundle', logLevel: 'error' })
const archive = join(temp, 'delivery.tgz')
execFileSync('tar', ['-czf', archive, '-C', root, 'dist/mac-arm64/Scry.app', 'scripts/desktop-remote-host-smoke.mjs', 'scripts/owned-app-processes.mjs', '-C', temp, 'desktop-transport-client.mjs'], { stdio: 'pipe' })
execFileSync('scp', ['-o', 'BatchMode=yes', archive, `${target}:${remote}/delivery.tgz`], { stdio: 'inherit' })
let output
try {
  output = ssh(`cd '${remote}' && tar -xzf delivery.tgz && node scripts/desktop-remote-host-smoke.mjs --transport-client=./desktop-transport-client.mjs`)
  writeFileSync(join(temp, 'acceptance.log'), output, { mode: 0o600 })
  const result = output.trim().split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.workbench)
  if (!result?.workbench.realPtyCwdAndInput || !result?.workbench.realGitStageCommit) throw new Error('Missing real-machine acceptance evidence')
  const localHash = createHash('sha256').update(readFileSync(asar)).digest('hex')
  const remoteHash = ssh(`shasum -a 256 '${remote}/dist/mac-arm64/Scry.app/Contents/Resources/app.asar'`).trim().split(/\s/)[0]
  if (localHash !== remoteHash) throw new Error('Remote application artifact differs from the local verified artifact')
  console.log(JSON.stringify({ target, remoteDirectory: remote, appAsarSHA256: localHash, localLog: join(temp, 'acceptance.log'), result }))
  // Keep the isolated app and the bounded evidence path for inspection, not a
  // background host. The host smoke proves owned-process exit before returning.
  rmSync(archive)
} catch (error) {
  writeFileSync(join(temp, 'failure.log'), `${output ?? ''}\n${error.stack ?? error}`, { mode: 0o600 })
  console.error(`Real-machine evidence retained: local=${temp} remote=${remote}`)
  throw error
}
