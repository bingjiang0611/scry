import { lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { execFileOutcome } from '../claude-locate'

// A keychain or password-manager read is a local lookup; anything slower is not a usable identity.
export const PI_CONFIG_HELPER_TIMEOUT_MS = 5_000
const PI_CONFIG_HELPER_LIMIT = 16

/**
 * Content identity of one Pi config file, for the managed-handoff continuation key.
 *
 * Pi resolveConfigValue executes `!command` values for auth keys and model headers. Hashing the
 * command source would say nothing about the credential the run receives, so resolve the helper
 * the same way Pi does and hash the result: a rotated key changes the continuation key and a stale
 * request is rejected, instead of silently resuming on an unprovable credential.
 */
export async function piConfigDigest(path: string, env: Record<string, string>): Promise<string | undefined> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Pi 配置不是受支持的普通文件或超过 4 MiB')
  const bytes = await readFile(path)
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Pi 配置 JSON 无效，接续身份不可用') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi 配置必须是对象')
  const raw = createHash('sha256').update(bytes).digest('hex')
  if (!hasDynamicValue(value)) return raw
  // settings.json keeps its reviewed behaviour: a project-owned helper stays opaque here.
  if (basename(path) === 'settings.json') return raw
  const resolved = await resolveHelpers(value, env, { left: PI_CONFIG_HELPER_LIMIT })
  // Same effective config must yield the same identity however it was written, so hash the resolved
  // JSON rather than the file bytes that still contain the helper command.
  return createHash('sha256').update(JSON.stringify(resolved)).digest('hex')
}

const hasDynamicValue = (candidate: unknown): boolean => typeof candidate === 'string' ? candidate.startsWith('!') :
  Boolean(candidate && typeof candidate === 'object' && Object.values(candidate).some(hasDynamicValue))

// The helper output is a credential: it stays inside this function and only its hash travels.
async function resolveHelpers(
  candidate: unknown,
  env: Record<string, string>,
  budget: { left: number }
): Promise<unknown> {
  if (typeof candidate === 'string') {
    if (!candidate.startsWith('!')) return candidate
    if (budget.left-- <= 0) throw new Error('Pi 动态配置 helper 超过可验证上限；接续身份不可用')
    const outcome = await execFileOutcome('/bin/sh', ['-c', candidate.slice(1)], { env, timeout: PI_CONFIG_HELPER_TIMEOUT_MS })
    if (outcome.exitCode !== 0) throw new Error('Pi 动态配置 helper 未成功返回；接续身份不可用')
    return outcome.stdout
  }
  if (Array.isArray(candidate)) {
    return Promise.all(candidate.map(item => resolveHelpers(item, env, budget)))
  }
  if (candidate && typeof candidate === 'object') {
    const entries = await Promise.all(Object.entries(candidate as Record<string, unknown>)
      .map(async ([key, item]) => [key, await resolveHelpers(item, env, budget)] as const))
    return Object.fromEntries(entries)
  }
  return candidate
}
