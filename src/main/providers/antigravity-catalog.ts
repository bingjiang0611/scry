import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  capabilityReady,
  capabilityUnavailable,
  capabilityUnknown,
  type CapabilityEnvelope,
  type ProviderCommand,
  type ProviderContext,
  type SkillMeta
} from '../../shared/provider'
import type {
  AgentEffortOption,
  AgentModelOption,
  AgentRunControlCatalog
} from '../../shared/runtime'
import { shellEnv } from '../claude-locate'
import { explicitlyAllowedProviderEnvKeys } from '../provider-environment'
import { AcpClient, AcpRpcError } from './acp-client'
import { AntigravityEventTranslator } from './antigravity-events'
import {
  antigravityExecutable,
  AntigravityStderrTail,
  buildAntigravityLaunchEnv,
  forceKillAntigravityProcess,
  spawnAntigravityAcp
} from './antigravity-launch'
import {
  ANTIGRAVITY_CONFIG_DIR_ALIASES,
  antigravityEffectiveGeminiRoot,
  antigravityGeminiRoot,
  AntigravityInvalidGeminiHomeError,
  antigravityScanRoots
} from './antigravity-mcp-paths'
import { ANTIGRAVITY_PERMISSION_OPTIONS } from './antigravity-permissions'
import { formatAntigravityUnauthenticatedError } from './antigravity-run'

const CATALOG_TTL_MS = 5 * 60_000
const PROBE_EXIT_GRACE_MS = 2_000
const DEFAULT_PROBE_WAIT_TIMEOUT_MS = 5_000

interface AcpConfigOptionValue {
  value?: string
  name?: string
  description?: string
}

interface AcpConfigOption {
  id?: string
  category?: string
  currentValue?: string
  options?: AcpConfigOptionValue[]
}

interface CachedAntigravityCatalog {
  observedAt: number
  state: 'ready' | 'unauthenticated'
  reason?: string
  models: AgentModelOption[]
  commands: ProviderCommand[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGeminiModel(id: string, name: string): boolean {
  return /gemini/i.test(id) || /gemini/i.test(name)
}

function extractConfigOptions(raw: unknown): AcpConfigOption[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is AcpConfigOption => isRecord(item))
}

function parseThoughtLevels(configOptions: readonly AcpConfigOption[]): AgentEffortOption[] {
  const thoughtOpt = configOptions.find((opt) => opt.id === 'thought_level' || opt.category === 'thought_level')
  if (!thoughtOpt || !Array.isArray(thoughtOpt.options)) return []
  const current = typeof thoughtOpt.currentValue === 'string' ? thoughtOpt.currentValue : undefined
  return thoughtOpt.options
    .filter((item): item is AcpConfigOptionValue & { value: string } => typeof item.value === 'string' && item.value.length > 0)
    .map((item) => ({
      id: item.value,
      label: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.value,
      ...(typeof item.description === 'string' && item.description.trim() ? { description: item.description.trim() } : {}),
      ...(current === item.value ? { isDefault: true } : {})
    }))
}

function isAuthError(error: unknown, loginPromptDetected: boolean): boolean {
  if (loginPromptDetected) return true
  if (error instanceof AcpRpcError) {
    if (error.code === -32000) return true
    if (error.code === -32603 && /no browser|auth|login|sign in/i.test(error.message)) return true
  }
  return false
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key === 'name' && value) out.name = value
    if (key === 'description' && value) out.description = value
  }
  return out
}

export function listAntigravitySkills(
  cwd: string | undefined,
  homeDir: string,
  env?: NodeJS.ProcessEnv
): SkillMeta[] {
  // B1: derive user-level skill directory from the same sanitized launch env `agy` receives.
  const geminiRoot = env ? antigravityEffectiveGeminiRoot(homeDir, env) : antigravityGeminiRoot(homeDir, buildAntigravityLaunchEnv())
  const roots: Array<{ dir: string; scope: string }> = [
    { dir: join(geminiRoot, 'config', 'skills'), scope: 'user' }
  ]
  if (cwd) {
    for (const scanRoot of antigravityScanRoots(cwd)) {
      for (const alias of ANTIGRAVITY_CONFIG_DIR_ALIASES) {
        roots.push({ dir: join(scanRoot, alias, 'skills'), scope: 'project' })
      }
    }
  }
  const seen = new Set<string>()
  const skills: SkillMeta[] = []
  for (const { dir, scope } of roots) {
    if (!existsSync(dir)) continue
    try {
      const dirStat = lstatSync(dir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const skillDir = join(dir, entry.name)
        const skillFile = join(skillDir, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        const fileStat = lstatSync(skillFile)
        if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 256 * 1024) continue
        const meta = parseFrontmatter(readFileSync(skillFile, 'utf8'))
        const name = meta.name || entry.name
        const key = `${scope}\0${name}`
        if (seen.has(key)) continue
        seen.add(key)
        skills.push({
          name,
          dir: skillDir,
          scope,
          description: meta.description ?? '',
          enabled: true
        })
      }
    } catch {
      // Unreadable skill directory is skipped in read-only listing.
    }
  }
  return skills
}

export function createAntigravityCatalog(deps: {
  homeDir: string
  continuationKey: (context: ProviderContext) => Promise<string>
  clientVersion?: string
  now?: () => number
  /** Upper bound for a catalog probe waiting on active runs when no stale cache exists (N4). */
  probeWaitTimeoutMs?: number
}) {
  const now = deps.now ?? Date.now
  const probeWaitTimeoutMs = deps.probeWaitTimeoutMs ?? DEFAULT_PROBE_WAIT_TIMEOUT_MS
  const cache = new Map<string, CachedAntigravityCatalog>()
  const inFlight = new Map<string, Promise<CachedAntigravityCatalog>>()
  // B2/D5/N4: Reader-writer gate — concurrent runs NEVER serialize each other, while catalog probes
  // remain mutually exclusive with active runs on the same profile. Queued runs abort immediately,
  // and catalog probes wait at most `probeWaitTimeoutMs` instead of hanging indefinitely.
  let activeRuns = 0
  let probeActive = false
  const probeWaiters: Array<{ grant: () => void }> = []
  const runWaiters = new Set<{ grant: () => void; cancel: () => void }>()

  const pumpGate = (): void => {
    if (!probeActive && runWaiters.size > 0) {
      const pending = [...runWaiters]
      runWaiters.clear()
      for (const waiter of pending) {
        activeRuns += 1
        waiter.grant()
      }
      return
    }
    if (!probeActive && activeRuns === 0 && probeWaiters.length > 0) {
      probeActive = true
      const next = probeWaiters.shift()!
      next.grant()
    }
  }

  const runExclusive = async <T>(fn: () => Promise<T>, waitTimeoutMs = probeWaitTimeoutMs): Promise<T> => {
    if (probeActive || activeRuns > 0) {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const entry = {
          grant: () => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            resolve()
          }
        }
        const timer = waitTimeoutMs > 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              const idx = probeWaiters.indexOf(entry)
              if (idx >= 0) probeWaiters.splice(idx, 1)
              reject(new Error('Antigravity 正在执行对话，目录探测等待超时；将在当前运行结束后重试'))
            }, waitTimeoutMs)
          : undefined
        probeWaiters.push(entry)
      })
    } else {
      probeActive = true
    }
    try {
      return await fn()
    } finally {
      probeActive = false
      pumpGate()
    }
  }

  const probeOnce = async (): Promise<CachedAntigravityCatalog> => {
    const executable = antigravityExecutable()
    if (!executable) {
      throw new Error('未找到 agy 可执行文件；请安装 Antigravity CLI 或设置 SCRY_AGY_PATH')
    }
    const rawEnv: Record<string, string | undefined> = { ...shellEnv(), ...process.env }
    const baseEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawEnv)) if (v !== undefined) baseEnv[k] = v
    // Reject relative GEMINI_HOME from the exact sanitized launch env before spawning agy.
    antigravityGeminiRoot(deps.homeDir, buildAntigravityLaunchEnv(baseEnv))

    const probeDir = mkdtempSync(join(tmpdir(), 'scry-agy-probe-'))
    chmodSync(probeDir, 0o700)
    const stderrTail = new AntigravityStderrTail()
    let client: AcpClient | undefined
    let spawned: ReturnType<typeof spawnAntigravityAcp> | undefined
    let exitPromise: Promise<void> | undefined

    try {
      spawned = spawnAntigravityAcp({
        cwd: probeDir,
        permissionMode: 'default',
        executable,
        baseEnv,
        stderrTail
      })
      exitPromise = new Promise<void>((resolve) => { spawned!.child.once('exit', () => resolve()) })
      const translator = new AntigravityEventTranslator('agy-catalog-probe', () => {})
      client = new AcpClient(spawned.child, {
        onNotification: (method, params) => translator.handleNotification(method, params)
      })
      await client.initialize(deps.clientVersion ?? '0.2.250')

      const openNew = () => client!.request<{ sessionId: string; configOptions?: unknown }>('session/new', {
        cwd: probeDir,
        mcpServers: []
      })

      let created: { sessionId: string; configOptions?: unknown }
      try {
        created = await openNew()
      } catch (err) {
        const allowed = explicitlyAllowedProviderEnvKeys(rawEnv.SCRY_PROVIDER_ENV_ALLOW, 'antigravity')
        if (err instanceof AcpRpcError && err.code === -32000 && !client.loginPromptDetected) {
          if (allowed.has('GEMINI_API_KEY') && rawEnv.GEMINI_API_KEY) {
            await client.request('authenticate', { methodId: 'gemini-api-key' })
            created = await openNew()
          } else if (allowed.has('AGY_ADC_AUTH') && rawEnv.AGY_ADC_AUTH && (rawEnv.GOOGLE_CLOUD_PROJECT || rawEnv.GCLOUD_PROJECT)) {
            await client.request('authenticate', { methodId: 'agent-platform' })
            created = await openNew()
          } else {
            throw err
          }
        } else {
          throw err
        }
      }

      const initialConfig = extractConfigOptions(created.configOptions)
      const modelOption = initialConfig.find((opt) => opt.id === 'model' || opt.category === 'model')
      const defaultModelId = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined
      const rawModels = Array.isArray(modelOption?.options) ? modelOption.options : []
      const models: AgentModelOption[] = []

      for (const item of rawModels) {
        if (!item || typeof item.value !== 'string' || !item.value) continue
        const modelId = item.value
        const label = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : modelId
        let efforts: AgentEffortOption[]
        if (modelId === defaultModelId) {
          efforts = parseThoughtLevels(initialConfig)
        } else {
          const switched = await client.request<{ configOptions?: unknown }>('session/set_config_option', {
            sessionId: created.sessionId,
            configId: 'model',
            value: modelId
          })
          efforts = parseThoughtLevels(extractConfigOptions(switched?.configOptions))
        }
        const vendorTag = isGeminiModel(modelId, label) ? undefined : '经 Antigravity 提供'
        const rawDesc = typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined
        const description = vendorTag
          ? (rawDesc ? `${rawDesc}（${vendorTag}）` : vendorTag)
          : rawDesc
        models.push({
          model: { id: modelId },
          label,
          ...(description ? { description } : {}),
          ...(modelId === defaultModelId ? { isDefault: true } : {}),
          efforts
        })
      }

      // Give available_commands_update a brief microtask tick if sent right after session/new.
      await new Promise((resolve) => setTimeout(resolve, 25))
      return {
        observedAt: now(),
        state: 'ready',
        models,
        commands: translator.availableCommands
      }
    } catch (error) {
      if (isAuthError(error, client?.loginPromptDetected === true)) {
        await forceKillAntigravityProcess(spawned?.identityPromise)
        return {
          observedAt: now(),
          state: 'unauthenticated',
          reason: formatAntigravityUnauthenticatedError(rawEnv),
          models: [],
          commands: []
        }
      }
      const wrapped = error instanceof Error ? error : new Error(String(error))
      stderrTail.attach(wrapped)
      throw wrapped
    } finally {
      client?.closeStdin()
      if (exitPromise && spawned) {
        const exited = await Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_EXIT_GRACE_MS))
        ])
        if (!exited) await forceKillAntigravityProcess(spawned.identityPromise)
      }
      // Remove only our temporary 0700 probe directory; never touch user ~/.gemini data (D5).
      try { rmSync(probeDir, { recursive: true, force: true }) } catch {  }
    }
  }

  const readCached = async (context: ProviderContext): Promise<CachedAntigravityCatalog> => {
    const key = await deps.continuationKey(context).catch((err) => {
      if (err instanceof AntigravityInvalidGeminiHomeError) throw err
      return `fallback:${antigravityExecutable() ?? 'missing'}`
    })
    const existing = cache.get(key)
    if (existing && now() - existing.observedAt < CATALOG_TTL_MS) return existing
    // N4: when runs are active (e.g. waiting on approval) and stale cache exists, return stale cache
    // immediately so model/command lists never stall indefinitely after the 5-minute TTL expires.
    if (existing && activeRuns > 0) return existing
    const pending = inFlight.get(key)
    if (pending) return pending
    const task = runExclusive(async () => {
      const rechecked = cache.get(key)
      if (rechecked && now() - rechecked.observedAt < CATALOG_TTL_MS) return rechecked
      const result = await probeOnce()
      cache.set(key, result)
      return result
    }).finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key)
    })
    inFlight.set(key, task)
    return task
  }

  const enterRun = async (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) throw new Error('antigravity_run_cancelled_before_start')
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      activeRuns = Math.max(0, activeRuns - 1)
      pumpGate()
    }
    if (!probeActive) {
      activeRuns += 1
      return release
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        runWaiters.delete(waiter)
        reject(new Error('antigravity_run_cancelled_before_start'))
      }
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        cancel: onAbort
      }
      runWaiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    if (signal?.aborted) {
      release()
      throw new Error('antigravity_run_cancelled_before_start')
    }
    return release
  }

  return {
    runExclusive,
    enterRun,
    async runControls(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> {
      try {
        const entry = await readCached(context)
        if (entry.state === 'unauthenticated') {
          return capabilityUnavailable(context, 'unsupported', entry.reason!)
        }
        return capabilityReady(
          context,
          'read',
          { models: entry.models, permissions: [...ANTIGRAVITY_PERMISSION_OPTIONS] },
          entry.observedAt
        )
      } catch (error) {
        return capabilityUnknown(context, 'read', error instanceof Error ? error.message : String(error))
      }
    },
    async commands(context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>> {
      try {
        const entry = await readCached(context)
        if (entry.state === 'unauthenticated') {
          return capabilityUnavailable(context, 'unsupported', entry.reason!)
        }
        return capabilityReady(context, 'read', entry.commands, entry.observedAt)
      } catch (error) {
        return capabilityUnknown(context, 'read', error instanceof Error ? error.message : String(error))
      }
    },
    async skills(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>> {
      return capabilityReady(context, 'read', listAntigravitySkills(context.cwd, deps.homeDir, { ...shellEnv(), ...process.env }), now())
    },
    invalidate(): void {
      cache.clear()
    }
  }
}
