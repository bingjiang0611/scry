import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve, posix, sep } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import { defaultPackagedAppPath, packagedAppLayout } from './packaged-app-layout.mjs'

const layout = packagedAppLayout(resolve(process.argv[2] || defaultPackagedAppPath()))
const appPath = layout.appPath
const resources = layout.resources
const asarPath = join(resources, 'app.asar')
const unpacked = join(resources, 'app.asar.unpacked')
const qoderRelative = join('node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_bundled', 'qodercli')
const qoderIndexRelative = join('node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', 'index.js')
const ptyRootRelative = join('node_modules', 'node-pty')
const maxBytes = Number(process.env.SCRY_APP_MAX_BYTES || 330 * 1024 * 1024)
const scryCli = join(resources, 'bin', 'scry')
const scryCliPackage = join(resources, 'scry-cli', 'package.json')
const scryPiIntegration = join(resources, 'scry-cli', 'integrations', 'pi-scry-recorder.mjs')
const electronResources = layout.locales

function directoryBytes(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size
  return readdirSync(path).reduce((total, name) => total + directoryBytes(join(path, name)), 0)
}

if (!existsSync(asarPath)) throw new Error(`packaged app 缺少 app.asar：${asarPath}`)
const entries = listPackage(asarPath)
const entrySet = new Set(entries)
const mainJavaScript = entries.filter((entry) => entry.startsWith('/out/main/') && entry.endsWith('.js'))
const packagedMainSources = mainJavaScript.map((entry) => extractFile(asarPath, entry.slice(1)).toString('utf8'))
// A linked node_modules can make the packager collect direct dependencies but
// omit their required children. Check the actual archive, not the checkout.
const packageFiles = ['/package.json', ...entries.filter(entry => /\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(entry))]
let runtimeDependencies = 0
for (const packageFile of packageFiles) {
  const metadata = JSON.parse(extractFile(asarPath, packageFile.slice(1)).toString('utf8'))
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    if (Object.hasOwn(metadata.optionalDependencies ?? {}, name)) continue
    let directory = posix.dirname(packageFile)
    let found = false
    while (true) {
      if (entrySet.has(posix.join(directory, 'node_modules', name, 'package.json'))) {
        found = true
        break
      }
      if (directory === '/') break
      directory = posix.dirname(directory)
    }
    if (!found) throw new Error(`packaged app 缺少运行时传递依赖：${metadata.name ?? packageFile} → ${name}`)
    runtimeDependencies += 1
  }
}
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
for (const daemonEntry of ['/out/main/daemon.js', '/out/main/daemon-supervisor.js']) {
  if (!entries.includes(daemonEntry)) throw new Error(`packaged app 缺少 daemon 入口：${daemonEntry}`)
}
// The daemon entry is not necessarily one file: rollup moves shared modules into
// /out/main/chunks and leaves the entry as a re-export. Follow this entry's own relative
// imports so the supervisor assertion still reads the code that will actually run.
function entryBundle(entryFile) {
  const seen = new Set()
  const pending = [entryFile]
  const parts = []
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = extractFile(asarPath, file).toString('utf8')
    parts.push(source)
    for (const match of source.matchAll(/(?:from|import)\s*["'](\.\/[^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1]))
      if (target.startsWith('out/main/') && entrySet.has(`/${target}`)) pending.push(target)
    }
  }
  return parts.join('\n')
}
const supervisorSource = entryBundle('out/main/daemon-supervisor.js')
if (!packagedMainSources.some((source) => source.includes('SCRY_DAEMON_USER_DATA_DIR'))) throw new Error('packaged daemon 缺少显式 userData 接线')
if (!supervisorSource.includes('ELECTRON_RUN_AS_NODE')) throw new Error('packaged daemon supervisor 未使用 Electron Node 模式')
for (const key of ['SCRY_DAEMON_APP_PATH', 'SCRY_DAEMON_RESOURCES_PATH', 'SCRY_DAEMON_APP_VERSION', 'SCRY_DAEMON_PACKAGED']) {
  if (!packagedMainSources.some((source) => source.includes(key))) throw new Error(`packaged daemon 缺少必需环境接线：${key}`)
}
if (!packagedMainSources.some((source) => source.includes('daemon_config_missing_'))) throw new Error('packaged daemon 缺少 fail-closed 配置校验')
if (entries.some((entry) => /^\/out\/preload\/.*\.mjs$/.test(entry))) {
  throw new Error('packaged app 仍包含 sandbox 无法执行的 ESM preload')
}
const bundledCliInAsar = entries.some((entry) => /\/qoder-agent-sdk\/dist\/_bundled\/qodercli(?:\/|$)/.test(entry))
const bundledCliUnpacked = existsSync(join(unpacked, qoderRelative))
if (bundledCliInAsar || bundledCliUnpacked) throw new Error('packaged app 仍包含未使用的 Qoder bundled qodercli')

const sdkIndexInAsar = entries.includes(`/${qoderIndexRelative.replaceAll('\\', '/')}`)
const sdkIndexUnpacked = existsSync(join(unpacked, qoderIndexRelative))
if (!sdkIndexInAsar && !sdkIndexUnpacked) throw new Error('排除 Qoder CLI 时误删了 Qoder SDK JavaScript adapter')

// node-pty 在 macOS 用随包分发的 prebuilds + spawn-helper（posix_spawn）；
// Linux 走 node-gyp 的 build/Release forkpty binding，没有 spawn-helper。
if (process.platform === 'darwin') {
  const ptyPrebuild = join(unpacked, ptyRootRelative, 'prebuilds', `darwin-${process.arch}`, 'pty.node')
  const ptySpawnHelper = join(unpacked, ptyRootRelative, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  if (!existsSync(ptyPrebuild)) throw new Error(`packaged app 缺少 node-pty native binding：${ptyPrebuild}`)
  accessSync(ptySpawnHelper, constants.X_OK)
} else {
  const ptyBinding = join(unpacked, ptyRootRelative, 'build', 'Release', 'pty.node')
  if (!existsSync(ptyBinding)) throw new Error(`packaged app 缺少 node-pty native binding：${ptyBinding}`)
}

if (!resolve(scryCli).startsWith(resolve(resources) + sep)) throw new Error('App 私有 CLI 不是 Resources 下的绝对路径')
accessSync(scryCli, constants.X_OK)
if (!existsSync(scryCliPackage)) throw new Error('packaged app 缺少 App 私有 Scry CLI package.json')
if (!existsSync(scryPiIntegration)) throw new Error('packaged app 缺少 Pi recorder integration')
const historyExtension = join(resources, 'scry-history', 'pi-history-reader.mjs')
if (!existsSync(historyExtension) || !lstatSync(historyExtension).isFile()) throw new Error('packaged app 缺少普通文件 Pi history reader')
const historyExtensionHash = createHash('sha256').update(readFileSync(historyExtension)).digest('hex')
if (!packagedMainSources.some((source) => source.includes(historyExtensionHash))) {
  throw new Error('packaged Pi history reader 与 main 运行图中固定的扩展指纹不匹配')
}
// Electron 的 locale 文件命名随平台不同：macOS 是 <lang>.lproj/locale.pak，
// Linux 是 Chromium 的 <lang>-<REGION>.pak。electronLanguages 按文件名精确匹配，
// 所以 Linux 必须在 electron-builder.yml 里单独声明 en-US/zh-CN/zh-TW，否则会被全部裁掉。
const locales = process.platform === 'darwin'
  ? { required: ['en.lproj', 'zh_CN.lproj', 'zh_TW.lproj'], forbidden: ['fr.lproj', 'de.lproj', 'ja.lproj'], inner: 'locale.pak' }
  : { required: ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'], forbidden: ['fr.pak', 'de.pak', 'ja.pak', 'en-GB.pak'], inner: null }
for (const locale of locales.required) {
  const localePath = locales.inner ? join(electronResources, locale, locales.inner) : join(electronResources, locale)
  if (!existsSync(localePath)) throw new Error(`packaged app 缺少必需 locale：${localePath}`)
}
for (const locale of locales.forbidden) {
  const localePath = join(electronResources, locale)
  if (existsSync(localePath)) throw new Error(`packaged app 未裁剪非目标 locale：${localePath}`)
}
const expectedCliVersion = JSON.parse(readFileSync(scryCliPackage, 'utf8')).version
// 首次执行刚签名的 bundle 可能触发 macOS 冷启动校验；仍保持有界，但不要把系统负载误判成 CLI 缺失。
const actualCliVersion = execFileSync(scryCli, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
if (actualCliVersion !== expectedCliVersion) {
  throw new Error(`App 私有 Scry CLI 版本不匹配：expected ${expectedCliVersion}, got ${actualCliVersion || 'unknown'}`)
}

const bytes = directoryBytes(appPath)
if (bytes > maxBytes) {
  throw new Error(`packaged app 超过体积预算：${bytes} > ${maxBytes} bytes`)
}
const sizeBreakdown = {
  ...(process.platform === 'darwin' ? { frameworks: directoryBytes(join(appPath, 'Contents', 'Frameworks')) } : {}),
  asar: directoryBytes(asarPath),
  unpacked: directoryBytes(unpacked),
  privateCli: directoryBytes(join(resources, 'scry-cli'))
}
console.log(JSON.stringify({
  appPath,
  platform: process.platform,
  bytes,
  maxBytes,
  sizeBreakdown,
  preload: 'cjs',
  qoderBundledCli: false,
  qoderSdk: true,
  runtimeDependencies,
  nodePty: true,
  scryCliBundled: true,
  scryCliVersion: actualCliVersion,
  historyExtensionHash
}))
