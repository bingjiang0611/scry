import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { listPackage } from '@electron/asar'

const appPath = resolve(process.argv[2] || join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app'))
const resources = join(appPath, 'Contents', 'Resources')
const asarPath = join(resources, 'app.asar')
const unpacked = join(resources, 'app.asar.unpacked')
const qoderRelative = join('node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_bundled', 'qodercli')
const qoderIndexRelative = join('node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', 'index.js')
const ptyRootRelative = join('node_modules', 'node-pty')
const maxBytes = Number(process.env.SCRY_APP_MAX_BYTES || 380 * 1024 * 1024)
const scryCli = join(resources, 'bin', 'scry')
const scryCliPackage = join(resources, 'scry-cli', 'package.json')

function directoryBytes(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((total, name) => total + directoryBytes(join(path, name)), 0)
}

if (!existsSync(asarPath)) throw new Error(`packaged app 缺少 app.asar：${asarPath}`)
const entries = listPackage(asarPath)
const exactRuntimeFiles = new Set([
  '/package.json',
  '/LICENSE',
  '/THIRD_PARTY_NOTICES.md',
  '/fixtures',
  '/fixtures/billing',
  '/fixtures/billing/anthropic-gateway-response.json'
])
const unexpected = entries.filter((entry) =>
  !exactRuntimeFiles.has(entry) &&
  !entry.startsWith('/out/') &&
  entry !== '/out' &&
  !entry.startsWith('/node_modules/') &&
  entry !== '/node_modules'
)
if (unexpected.length > 0) {
  throw new Error(`packaged app 包含 allowlist 外文件：${unexpected.slice(0, 10).join(', ')}`)
}
for (const required of ['/package.json', '/LICENSE', '/THIRD_PARTY_NOTICES.md']) {
  if (!entries.includes(required)) throw new Error(`packaged app 缺少发布文件：${required}`)
}
for (const forbiddenRoot of ['/.claude', '/.local', '/src', '/docs', '/scripts', '/out/cli', '/audit-report-scry-2026-07-31.md']) {
  if (entries.some((entry) => entry === forbiddenRoot || entry.startsWith(`${forbiddenRoot}/`))) {
    throw new Error(`packaged app 泄露构建 checkout 内容：${forbiddenRoot}`)
  }
}
if (!entries.includes('/out/preload/index.cjs')) {
  throw new Error('packaged app 缺少 sandbox-compatible CommonJS preload')
}
if (entries.some((entry) => /^\/out\/preload\/.*\.mjs$/.test(entry))) {
  throw new Error('packaged app 仍包含 sandbox 无法执行的 ESM preload')
}
const bundledCliInAsar = entries.some((entry) => /\/qoder-agent-sdk\/dist\/_bundled\/qodercli(?:\/|$)/.test(entry))
const bundledCliUnpacked = existsSync(join(unpacked, qoderRelative))
if (bundledCliInAsar || bundledCliUnpacked) throw new Error('packaged app 仍包含未使用的 Qoder bundled qodercli')

const sdkIndexInAsar = entries.includes(`/${qoderIndexRelative.replaceAll('\\', '/')}`)
const sdkIndexUnpacked = existsSync(join(unpacked, qoderIndexRelative))
if (!sdkIndexInAsar && !sdkIndexUnpacked) throw new Error('排除 Qoder CLI 时误删了 Qoder SDK JavaScript adapter')

const ptyPrebuild = join(unpacked, ptyRootRelative, 'prebuilds', `darwin-${process.arch}`, 'pty.node')
const ptySpawnHelper = join(unpacked, ptyRootRelative, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
if (!existsSync(ptyPrebuild)) throw new Error(`packaged app 缺少 node-pty native binding：${ptyPrebuild}`)
accessSync(ptySpawnHelper, constants.X_OK)

accessSync(scryCli, constants.X_OK)
if (!existsSync(scryCliPackage)) throw new Error('packaged app 缺少 App 私有 Scry CLI package.json')
const expectedCliVersion = JSON.parse(readFileSync(scryCliPackage, 'utf8')).version
const actualCliVersion = execFileSync(scryCli, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim()
if (actualCliVersion !== expectedCliVersion) {
  throw new Error(`App 私有 Scry CLI 版本不匹配：expected ${expectedCliVersion}, got ${actualCliVersion || 'unknown'}`)
}

const bytes = directoryBytes(appPath)
if (bytes > maxBytes) {
  throw new Error(`packaged app 超过体积预算：${bytes} > ${maxBytes} bytes`)
}
console.log(JSON.stringify({ appPath, bytes, maxBytes, preload: 'cjs', qoderBundledCli: false, qoderSdk: true, nodePty: true, scryCliBundled: true, scryCliVersion: actualCliVersion }))
