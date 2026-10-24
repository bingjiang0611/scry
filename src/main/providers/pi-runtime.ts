import { accessSync, constants, createReadStream, readFileSync, realpathSync, statSync } from 'node:fs'
import { access as accessAsync, lstat, readFile as readFileAsync, realpath as realpathAsync, stat as statAsync } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import type { PiAgentProfile } from '../pi-agent-profiles'
import { execFileText, resolveCommandOnPath, sanitizeProviderEnv, shellEnv } from '../claude-locate'

export const PI_HISTORY_EXTENSION_SHA256 = 'c86db7857dddea255eda02931d32827e62babc7a4b440e74d5ac8b7f2d11e186'
export const PI_BOOTSTRAP_MAX_BYTES = 64 * 1024
export const PI_NODE_PROBE_TIMEOUT_MS = 5_000
export const PI_RPC_COMMAND_TIMEOUT_MS = 15_000
// Resuming a large Pi session includes loading its JSONL history and extensions before the first
// response. That cold-start work can legitimately exceed an ordinary command's deadline (the
// reported 8.3 MiB session took about 20 seconds), so startup has its own bounded allowance.
export const PI_RPC_STARTUP_TIMEOUT_MS = 60_000
// Limit retained evidence per frame, not cumulative session output or redundant native snapshots.
// The decoder streams past repeated lifecycle payloads and projects get_entries to identity only.
// Larger live evidence still fails explicitly; supporting it requires a disk-backed evidence path,
// not a larger main-process heap or silent truncation.
export const PI_RPC_MAX_FRAME_BYTES = 64 * 1024 * 1024

function packagePiExecutable(executable: string): string | undefined {
  let canonical: string
  try {
    canonical = realpathSync(executable)
    const stat = statSync(canonical)
    if (!stat.isFile()) return undefined
    accessSync(canonical, constants.X_OK)
  } catch {
    return undefined
  }
  let directory = dirname(canonical)
  for (;;) {
    try {
      const packageJson = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        bin?: { pi?: unknown }
      }
      if (typeof packageJson.bin?.pi === 'string') {
        const declared = realpathSync(join(directory, packageJson.bin.pi))
        if (declared === canonical) return canonical
      }
    } catch {
      // Continue toward the filesystem root; wrappers and source checkouts may have unrelated package.json files.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function piRuntimeFromBootstrap(bootstrap: string): string | undefined {
  const packaged = packagePiExecutable(bootstrap)
  if (packaged) return packaged
  try {
    const stat = statSync(bootstrap)
    if (!stat.isFile() || stat.size > PI_BOOTSTRAP_MAX_BYTES) return undefined
    const source = readFileSync(bootstrap, 'utf8')
    const configured = source.match(/^\s*:\s*["']\$\{PI_AGENT_PI:=(\/[^\r\n}"']+)}["']\s*$/m)?.[1] ??
      source.match(/^\s*(?:export\s+)?PI_AGENT_PI\s*=\s*["']?(\/[^\r\n"']+?)["']?\s*(?:\\)?\s*$/m)?.[1]
    return configured ? packagePiExecutable(configured) : undefined
  } catch {
    return undefined
  }
}

interface PiPackageIdentity {
  name: string
  version: string
  root: string
  executable: string
}

async function piPackageIdentity(executable: string, expectedName: string): Promise<PiPackageIdentity | undefined> {
  let canonical: string
  try {
    canonical = await realpathAsync(executable)
    const info = await statAsync(canonical)
    if (!info.isFile()) return undefined
    await accessAsync(canonical, constants.X_OK)
  } catch {
    return undefined
  }
  let directory = dirname(canonical)
  for (;;) {
    try {
      const packagePath = join(directory, 'package.json')
      const packageJson = JSON.parse(await readFileAsync(packagePath, 'utf8')) as {
        name?: unknown
        version?: unknown
        bin?: { pi?: unknown; rotom?: unknown }
      }
      if (packageJson.name === expectedName && typeof packageJson.version === 'string') {
        const declared = packageJson.bin?.pi ?? packageJson.bin?.rotom
        if (typeof declared === 'string' && await realpathAsync(join(directory, declared)) === canonical) {
          return { name: packageJson.name, version: packageJson.version, root: directory, executable: canonical }
        }
        if (expectedName === '@bingjiang0611/rotom' && canonical === resolve(directory, 'bin', 'rotom-launcher')) {
          return { name: packageJson.name, version: packageJson.version, root: directory, executable: canonical }
        }
      }
    } catch {
      // Continue toward the filesystem root; an arbitrary wrapper must not become trusted.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

const ROTOM_HANDOFF_RESOURCES = ['bin/rotom-launcher', 'runtime/launch-runtime.mjs', 'runtime/verify-pi-runtime.mjs', 'runtime/resolve-installed-pi.mjs', 'runtime/product-config.mjs']
export const isRotomLauncher = (profile: PiAgentProfile): boolean => ['rotom', 'rotom-launcher'].includes(basename(profile.executable))
// Reviewed public delegation and product launcher contracts from Rotom 0.1.25.
// A changed shell launcher needs a new contract review, not marker-based trust.
const ROTOM_PUBLIC_ENTRY_HASH = 'c9f1dd3df66d995540c006e8f8cd930ab7bb9a8f0741aaf71e44c1bd56f15e80'
const ROTOM_PRODUCT_LAUNCHER_HASH = '89c5d505468726df13ebc87232b56e3d506a5c1c1d2cd989bc122d7e0bcb8bcd'

async function verifyRotomLauncher(profile: PiAgentProfile): Promise<PiPackageIdentity> {
  const launcher = await piPackageIdentity(profile.executable, '@bingjiang0611/rotom')
  if (!launcher || !['rotom', 'rotom-launcher'].some(name => launcher.executable === resolve(launcher.root, 'bin', name))) {
    throw new Error('Rotom launcher 不是已验证的产品 launcher')
  }
  try {
    const manifest = JSON.parse(await readFileAsync(join(launcher.root, 'package.json'), 'utf8')) as { bin?: { rotom?: unknown } }
    if (manifest.bin?.rotom !== 'bin/rotom') throw new Error('Rotom package bin contract 无效')
    if (basename(launcher.executable) === 'rotom' && await fileDigest(launcher.executable) !== ROTOM_PUBLIC_ENTRY_HASH) {
      throw new Error('Rotom public entry contract 未验证')
    }
    if (await fileDigest(join(launcher.root, 'bin/rotom-launcher')) !== ROTOM_PRODUCT_LAUNCHER_HASH) {
      throw new Error('Rotom product launcher contract 未验证')
    }
    for (const relativePath of ROTOM_HANDOFF_RESOURCES) {
      const resource = join(launcher.root, relativePath)
      const info = await lstat(resource)
      if (!info.isFile() || info.isSymbolicLink() || await realpathAsync(resource) !== resource) throw new Error('Rotom runtime resource contract 无效')
    }
  } catch (error) {
    throw new Error(`Rotom launcher contract 不可验证：${String((error as Error).message)}`)
  }
  return launcher
}

async function bundledPiIdentity(root: string): Promise<PiPackageIdentity | undefined> {
  const packageRoot = join(root, 'runtime', 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent')
  try {
    const packageJson = JSON.parse(await readFileAsync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
      bin?: { pi?: unknown }
    }
    if (packageJson.name !== '@earendil-works/pi-coding-agent' || typeof packageJson.version !== 'string' || typeof packageJson.bin?.pi !== 'string') return undefined
    const executable = await realpathAsync(join(packageRoot, packageJson.bin.pi))
    const stat = await statAsync(executable)
    if (!stat.isFile()) return undefined
    await accessAsync(executable, constants.X_OK)
    return { name: packageJson.name, version: packageJson.version, root: packageRoot, executable }
  } catch {
    return undefined
  }
}

async function nodeIdentity(env: Record<string, string>, rotom: boolean): Promise<string | undefined> {
  const candidate = env[rotom ? 'ROTOM_NODE' : 'PI_AGENT_NODE']
  if (!candidate) return undefined
  try {
    const canonical = await realpathAsync(candidate)
    const info = await statAsync(canonical)
    if (!info.isFile()) return undefined
    await accessAsync(canonical, constants.X_OK)
    return canonical
  } catch {
    return undefined
  }
}

// Runtime binaries are large. Coalesce hashing and retain at most 32 stat-bound
// digests; auth/config bytes are always read afresh at the input boundary.
const piBinaryDigests = new Map<string, { stamp: string; digest: Promise<string> }>()
export async function fileDigest(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 * 1024) throw new Error('Pi runtime 不是受支持的普通文件')
  const stamp = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
  const cached = piBinaryDigests.get(path)
  if (cached?.stamp === stamp) return cached.digest
  const digest = (async () => {
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length
      if (bytes > 512 * 1024 * 1024) throw new Error('Pi runtime 超过 512 MiB')
      hash.update(chunk)
    }
    return hash.digest('hex')
  })()
  if (piBinaryDigests.size >= 32) piBinaryDigests.delete(piBinaryDigests.keys().next().value!)
  piBinaryDigests.set(path, { stamp, digest })
  try { return await digest } catch (error) { piBinaryDigests.delete(path); throw error }
}

async function piConfigDigest(path: string): Promise<string | undefined> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Pi 配置不是受支持的普通文件或超过 4 MiB')
  const bytes = await readFileAsync(path)
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Pi 配置 JSON 无效，接续身份不可用') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi 配置必须是对象')
  // Pi resolveConfigValue executes !commands for auth keys and model headers.
  // Their future output cannot be proved by hashing their source command.
  const dynamic = (value: unknown): boolean => typeof value === 'string' ? value.startsWith('!') :
    Boolean(value && typeof value === 'object' && Object.values(value).some(dynamic))
  if (basename(path) !== 'settings.json' && dynamic(value)) throw new Error('Pi 动态配置 helper 的接续身份不可验证')
  return createHash('sha256').update(bytes).digest('hex')
}

/** Identity for managed handoff only; secret bytes are hashed, never returned or logged. */
export async function piContinuationKey(
  profile: PiAgentProfile,
  cwd: string | undefined,
  env: Record<string, string>
): Promise<string> {
  const rotom = isRotomLauncher(profile)
  const launcher = rotom
    ? await verifyRotomLauncher(profile)
    : await piPackageIdentity(profile.executable, '@earendil-works/pi-coding-agent')
  if (!launcher) throw new Error('Pi launcher 不是已知且可验证的 Pi/Rotom runtime；接续身份不可用')
  const runtime = rotom
    ? (env.ROTOM_PI !== undefined
        ? await piPackageIdentity(env.ROTOM_PI, '@earendil-works/pi-coding-agent')
        : await bundledPiIdentity(launcher.root))
    : launcher
  const node = await nodeIdentity(env, rotom)
  const configuredNamespace = env.PI_CODING_AGENT_DIR || (env.HOME ? join(env.HOME, '.pi', 'agent') : undefined)
  const configNamespace = configuredNamespace && resolve(cwd ?? process.cwd(),
    configuredNamespace === '~' && env.HOME ? env.HOME :
      configuredNamespace.startsWith('~/') && env.HOME ? join(env.HOME, configuredNamespace.slice(2)) : configuredNamespace)
  if (!runtime || !node || !configNamespace) throw new Error('Pi runtime、Node 或 config/auth namespace 不可验证；接续身份不可用')
  const namespaceInfo = await lstat(configNamespace).catch(() => undefined)
  if (!namespaceInfo?.isDirectory() || namespaceInfo.isSymbolicLink()) {
    throw new Error('Pi config/auth namespace 不是可验证的本地目录；接续身份不可用')
  }
  const canonicalConfigNamespace = await realpathAsync(configNamespace)
  const [nodeHash, launcherHash, runtimeHash, authHash, settingsHash, modelsHash, projectSettingsHash] = await Promise.all([
    fileDigest(node), fileDigest(launcher.executable), fileDigest(runtime.executable),
    piConfigDigest(join(canonicalConfigNamespace, 'auth.json')),
    piConfigDigest(join(canonicalConfigNamespace, 'settings.json')),
    piConfigDigest(join(canonicalConfigNamespace, 'models.json')),
    cwd ? piConfigDigest(join(cwd, '.pi', 'settings.json')) : undefined
  ])
  // models.json supports arbitrary named environment references, not only a
  // fixed list of known providers. Hash the actual sanitized launch environment.
  const authEnv = Object.keys(env).sort().map(name => `${name}=${createHash('sha256').update(env[name], 'utf8').digest('hex')}`)
  if (!authHash && !env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY) {
    throw new Error('Pi 缺少可验证的 auth namespace 或认证环境身份；接续身份不可用')
  }
  const resources = rotom ? await Promise.all(ROTOM_HANDOFF_RESOURCES.map(path => fileDigest(join(launcher.root, path)))) : []
  const identity = [
    ...resources,
    'scry-pi-continuation-v2', profile.id, cwd ?? '',
    `launcher:${launcher.executable}:${launcher.version}:${launcherHash}`,
    `runtime:${runtime.executable}:${runtime.version}:${runtimeHash}`, `node:${node}:${nodeHash}`,
    `config:${canonicalConfigNamespace}`, `auth:${authHash ?? 'env'}`, `settings:${settingsHash ?? 'missing'}`,
    `models:${modelsHash ?? 'missing'}`, `projectSettings:${projectSettingsHash ?? 'missing'}`, ...authEnv
  ]
  return `pi:${createHash('sha256').update(identity.join('\n'), 'utf8').digest('hex')}`
}

function compatibleNodeVersion(raw: string, rotom: boolean): boolean {
  const [major, minor] = raw.trim().split('.').map(Number)
  return major >= 24 || (!rotom && major === 23 && minor >= 6)
}

// Only cache a direct Node runtime, not a version-manager shim whose target can change without
// changing the shim. Each lookup revalidates file identity; the environment digest isolates profiles
// without retaining credentials as cache keys. This does not cache Provider capabilities or trust.
const piNodeVersions = new Map<string, Promise<string>>()
const PI_NODE_VERSION_CACHE_LIMIT = 32

async function compatiblePiNode(env: Record<string, string>, rotom: boolean): Promise<string | undefined> {
  const environment = createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    const candidate = resolveCommandOnPath('node', directory)
    if (!candidate) continue
    const canonical = await realpathAsync(candidate)
    const file = await statAsync(canonical, { bigint: true })
    const key = JSON.stringify([canonical, String(file.dev), String(file.ino), String(file.size),
      String(file.mtimeNs), String(file.ctimeNs), environment])
    let pending = piNodeVersions.get(key)
    if (!pending) {
      pending = execFileText(candidate, ['-p', 'JSON.stringify([process.execPath, process.versions.node])'], {
        env, timeout: PI_NODE_PROBE_TIMEOUT_MS
      }).then((raw) => {
        let response: unknown
        try { response = JSON.parse(raw) } catch { /* A failed/non-Node candidate is not reusable. */ }
        if (!Array.isArray(response) || response.length !== 2 || typeof response[0] !== 'string' || typeof response[1] !== 'string') {
          piNodeVersions.delete(key)
          return ''
        }
        if (response[0] !== canonical) piNodeVersions.delete(key)
        return response[1]
      })
      if (piNodeVersions.size >= PI_NODE_VERSION_CACHE_LIMIT) piNodeVersions.delete(piNodeVersions.keys().next().value!)
      piNodeVersions.set(key, pending)
    }
    const version = await pending
    if (compatibleNodeVersion(version, rotom)) return canonical
  }
  return undefined
}

function completePiEnvironment(profile: PiAgentProfile, env: Record<string, string>): Record<string, string> {
  if (basename(profile.executable) !== 'pi-agent') return env
  if (env.PI_AGENT_PI) return env
  const verified = env.PI_AGENT_VERIFIED_PI_EXECUTABLE
    ? packagePiExecutable(env.PI_AGENT_VERIFIED_PI_EXECUTABLE)
    : undefined
  const onPath = resolveCommandOnPath('pi', env.PATH ?? '')
  const runtime = verified ?? (onPath ? piRuntimeFromBootstrap(onPath) : undefined)
  if (runtime) env.PI_AGENT_PI = runtime
  return env
}

function pinPiLauncherNode(
  profile: PiAgentProfile,
  env: Record<string, string>,
  compatibleNode: string | undefined
): void {
  if (!compatibleNode) return
  if (isRotomLauncher(profile)) {
    if (!env.ROTOM_NODE) env.ROTOM_NODE = compatibleNode
    return
  }
  if (!env.PI_AGENT_NODE) env.PI_AGENT_NODE = compatibleNode
}

const PROXY_ENV_NAMES = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'
] as const

function enableRotomNodeEnvProxy(profile: PiAgentProfile, env: Record<string, string>): void {
  if (!isRotomLauncher(profile) || Object.hasOwn(env, 'NODE_USE_ENV_PROXY')) return
  // Node's built-in fetch/WebSocket stack does not consume HTTP(S)_PROXY merely because the
  // variables exist. Rotom's OpenAI Codex transport falls back from WebSocket to fetch/SSE, so
  // opt its Node >=24 runtime into the env-proxy dispatcher whenever a usable proxy is present.
  if (PROXY_ENV_NAMES.some((name) => Boolean(env[name]?.trim()))) env.NODE_USE_ENV_PROXY = '1'
}

export async function piRpcEnvironment(
  profile: PiAgentProfile,
  baseEnv: Record<string, string> = shellEnv()
): Promise<Record<string, string>> {
  const env = sanitizeProviderEnv(baseEnv, 'pi')
  // Discovery, profile validation and runs must use the same non-blocking launcher resolution.
  // Rotom requires Node >=24 and owns ROTOM_NODE; PI_AGENT_NODE belongs to the legacy launcher.
  const rotom = isRotomLauncher(profile)
  const configuredNode = rotom ? env.ROTOM_NODE : env.PI_AGENT_NODE
  const compatibleNode = configuredNode ?? await compatiblePiNode(env, rotom)
  pinPiLauncherNode(profile, env, compatibleNode)
  enableRotomNodeEnvProxy(profile, env)
  return completePiEnvironment(profile, env)
}
