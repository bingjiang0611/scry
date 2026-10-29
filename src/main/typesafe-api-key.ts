import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { lstat, readFile } from 'node:fs/promises'

const MAX_AUTH_BYTES = 1024 * 1024
const keychainReference = /^!security find-generic-password -ws ([A-Za-z0-9._:-]{1,128})$/

type Options = Readonly<{
  authPath?: string
  env?: NodeJS.ProcessEnv
  readKeychainService?: (service: string) => Promise<string | undefined>
}>

type ApiKeyCredential = Readonly<{ type: 'api_key'; key?: string; env?: Record<string, string> }>

function agentDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir()
  const configured = env.PI_CODING_AGENT_DIR
  if (!configured) return join(home, '.pi', 'agent')
  const expanded = configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

async function defaultReadKeychainService(service: string, keychainPath?: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const keychain = keychainPath && isAbsolute(keychainPath) ? [keychainPath] : []
  return await new Promise((resolveValue) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', service, ...keychain], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true
    }, (error, stdout) => resolveValue(error ? undefined : stdout.trim() || undefined))
  })
}

function interpolate(value: string, env: NodeJS.ProcessEnv, scoped: Record<string, string> | undefined): string | undefined {
  let resolved = ''
  let index = 0
  while (index < value.length) {
    const dollar = value.indexOf('$', index)
    if (dollar < 0) return resolved + value.slice(index)
    resolved += value.slice(index, dollar)
    const next = value[dollar + 1]
    if (next === '$' || next === '!') {
      resolved += next
      index = dollar + 2
      continue
    }
    const braced = next === '{' ? value.slice(dollar + 2).match(/^([A-Za-z_][A-Za-z0-9_]*)\}/) : undefined
    const plain = next !== '{' ? value.slice(dollar + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/) : undefined
    const name = braced?.[1] ?? plain?.[1]
    if (!name) {
      resolved += '$'
      index = dollar + 1
      continue
    }
    const item = scoped?.[name] || env[name]
    if (item === undefined) return undefined
    resolved += item
    index = dollar + (braced ? name.length + 3 : name.length + 1)
  }
  return resolved
}

async function credential(path: string): Promise<ApiKeyCredential | undefined> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_AUTH_BYTES) throw new Error('Pi auth.json is not a supported regular file')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi auth.json must be an object')
  const entry = (value as Record<string, unknown>).typesafe
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const input = entry as Record<string, unknown>
  if (input.type !== 'api_key' || (input.key !== undefined && typeof input.key !== 'string')) return undefined
  const entryEnv = input.env
  if (entryEnv !== undefined && (!entryEnv || typeof entryEnv !== 'object' || Array.isArray(entryEnv) || Object.values(entryEnv).some(item => typeof item !== 'string'))) return undefined
  return { type: 'api_key', ...(typeof input.key === 'string' ? { key: input.key } : {}), ...(entryEnv ? { env: entryEnv as Record<string, string> } : {}) }
}

/** Resolve the TypeSafe credential without exposing command execution from auth.json.
 * Scry accepts literals/environment templates plus Pi's exact macOS Keychain reference form.
 */
export function createTypeSafeApiKeyResolver(options: Options = {}): () => Promise<string | undefined> {
  const env = options.env ?? process.env
  const authPath = options.authPath ?? join(agentDirectory(env), 'auth.json')
  const readKeychainService = options.readKeychainService ?? ((service: string) => defaultReadKeychainService(service, env.SCRY_TYPESAFE_KEYCHAIN_PATH))
  return async () => {
    if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY
    const stored = await credential(authPath)
    if (!stored?.key) return undefined
    const reference = stored.key.match(keychainReference)
    if (reference) return await readKeychainService(reference[1]!)
    if (stored.key.startsWith('!')) return undefined
    return interpolate(stored.key, env, stored.env)
  }
}
