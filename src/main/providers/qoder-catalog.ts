import type { SlashCommand } from '@qoder-ai/qoder-agent-sdk'
import {
  capabilityReady,
  capabilityUnknown,
  type CapabilityEnvelope,
  type ProviderCommand,
  type ProviderContext,
  type SkillMeta
} from '../../shared/provider'
import type { AgentRunControlCatalog } from '../../shared/runtime'
import type { QoderControlPool } from './qoder-controls'
import { effortOption, permissionOptions } from './run-controls'
import { qoderRecord } from './qoder-shared'

interface Cached<T> {
  data: T
  observedAt: number
  /** Control-session generation this value was read under; a bump invalidates it. */
  generation: number
}

function qoderSkillScope(source: string): 'project' | 'user' | 'unknown' {
  const normalized = source.trim().toLowerCase()
  return normalized === 'project' || normalized === 'user' ? normalized : 'unknown'
}

interface QoderSkillDescriptor {
  name: string
  description: string
  source: string
  location: string
}

function qoderSkillCatalog(
  initialized: unknown,
  usage: unknown,
  commands: SlashCommand[]
): { skills: QoderSkillDescriptor[]; total: number; included: number } {
  const descriptions = new Map(commands.map((command) => [command.name, command.description]))
  const initializedSkills = qoderRecord(initialized).skills
  const usageSkills = qoderRecord(qoderRecord(usage).skills)
  const legacySkills = Array.isArray(usageSkills.skillFrontmatter) ? usageSkills.skillFrontmatter : []
  const modernSkills = Array.isArray(usageSkills.items) ? usageSkills.items : []
  const rows = [
    ...(Array.isArray(initializedSkills) ? initializedSkills : []),
    ...legacySkills,
    ...modernSkills
  ].map(qoderRecord)
  const byName = new Map<string, QoderSkillDescriptor>()
  for (const row of rows) {
    if (typeof row.name !== 'string' || !row.name) continue
    const current = byName.get(row.name)
    const location = [row.path, row.location, row.dir].find((value): value is string => typeof value === 'string')
    byName.set(row.name, {
      name: row.name,
      description: typeof row.description === 'string'
        ? row.description
        : current?.description ?? descriptions.get(row.name) ?? '',
      source: typeof row.source === 'string' ? row.source : current?.source ?? 'unknown',
      location: location ?? current?.location ?? ''
    })
  }
  const skills = [...byName.values()]
  const legacyTotal = typeof usageSkills.totalSkills === 'number' ? usageSkills.totalSkills : undefined
  const modernTotal = typeof usageSkills.count === 'number' ? usageSkills.count : undefined
  const total = Math.max(skills.length, legacyTotal ?? 0, modernTotal ?? 0)
  const included = Array.isArray(initializedSkills)
    ? skills.length
    : typeof usageSkills.includedSkills === 'number'
      ? Math.min(usageSkills.includedSkills, skills.length)
      : skills.length
  return { skills, total, included }
}


/**
 * Qoder catalog reads share one bounded cache policy per adapter: 30s TTL plus
 * control-session generation fencing, so an invalidated context never serves
 * metadata read from a retired control session.
 */
export interface QoderCatalog {
  skills(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>>
  commands(context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>>
  runControls(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>>
  invalidate(key: string): void
  dispose(): void
}

export function createQoderCatalog(pool: QoderControlPool): QoderCatalog {
  const PROBE_TTL_MS = 30_000
  const skillCache = new Map<string, Cached<{ data: SkillMeta[]; total: number; included: number }>>()
  const commandCache = new Map<string, Cached<{ commands: SlashCommand[]; skillNames?: Set<string>; reason?: string }>>()
  const modelCache = new Map<string, Cached<AgentRunControlCatalog>>()

  const skills = async (context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>> => {
    try {
      const key = context.cwd ?? ''
      const generation = pool.generation(key)
      let value = skillCache.get(key)
      if (!value || value.generation !== generation || Date.now() - value.observedAt >= PROBE_TTL_MS) {
        const result = await pool.withControl(context, async (q, initialized) => {
          const [usage, commands] = await Promise.all([q.getContextUsage(), q.supportedCommands()])
          const catalog = qoderSkillCatalog(initialized, usage, commands)
          return {
            data: catalog.skills.map((skill) => ({
              name: skill.name,
              dir: skill.location,
              scope: qoderSkillScope(skill.source),
              description: skill.description,
              enabled: true
            })),
            total: catalog.total,
            included: catalog.included
          }
        })
        const catalog = result.value
        value = { data: catalog, observedAt: result.initializedAt, generation }
        if (
          generation === pool.generation(key) &&
          pool.current(key) === result.session &&
          !result.session.retired
        ) {
          skillCache.delete(key)
          skillCache.set(key, value)
          while (skillCache.size > 16) {
            const oldest = skillCache.keys().next().value
            if (oldest === undefined) break
            skillCache.delete(oldest)
          }
        }
      }
      const ready = capabilityReady(context, 'read', value.data.data, value.observedAt)
      return value.data.included < value.data.total
        ? { ...ready, state: 'degraded' as const, reason: `Qoder 仅返回 ${value.data.included}/${value.data.total} 个已加载 Skill 的元数据` }
        : ready
    } catch (error) {
      return capabilityUnknown<SkillMeta[]>(context, 'read', String((error as Error).message))
    }
  }

  const commands = async (context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>> => {
    try {
      const key = context.cwd ?? ''
      const generation = pool.generation(key)
      let value = commandCache.get(key)
      if (!value || value.generation !== generation || Date.now() - value.observedAt >= PROBE_TTL_MS) {
        const result = await pool.withControl(context, async (q, initialized) => {
          const commands = await q.supportedCommands()
          try {
            const catalog = qoderSkillCatalog(initialized, await q.getContextUsage(), commands)
            return {
              commands,
              skillNames: new Set(catalog.skills.map((skill) => skill.name)),
              ...(catalog.included < catalog.total
                ? { reason: `Qoder 仅返回 ${catalog.included}/${catalog.total} 个已加载 Skill，其他命令来源保持未知` }
                : {})
            }
          } catch (error) {
            const initializedCatalog = qoderSkillCatalog(initialized, undefined, commands)
            return {
              commands,
              skillNames: new Set(initializedCatalog.skills.map((skill) => skill.name)),
              reason: `Qoder Skill catalog 读取失败，命令来源按初始化证据分类：${String((error as Error).message)}`
            }
          }
        })
        value = { data: result.value, observedAt: result.initializedAt, generation }
        if (
          generation === pool.generation(key) &&
          pool.current(key) === result.session &&
          !result.session.retired
        ) {
          commandCache.delete(key)
          commandCache.set(key, value)
          while (commandCache.size > 16) {
            const oldest = commandCache.keys().next().value
            if (oldest === undefined) break
            commandCache.delete(oldest)
          }
        }
      }
      const ready = capabilityReady(
        context,
        'read',
        value.data.commands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint || undefined,
          source: value.data.skillNames?.has(command.name) ? 'skill' as const : undefined
        })),
        value.observedAt
      )
      return value.data.reason ? { ...ready, state: 'degraded' as const, reason: value.data.reason } : ready
    } catch (error) {
      return capabilityUnknown(context, 'read', String((error as Error).message))
    }
  }

  const runControls = async (context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> => {
    try {
      const key = context.cwd ?? ''
      const generation = pool.generation(key)
      let value = modelCache.get(key)
      if (!value || value.generation !== generation || Date.now() - value.observedAt >= PROBE_TTL_MS) {
        const result = await pool.withControl(context, (q) =>
          q.getAvailableModels({ fetchStrategy: 'live' }),
          { requireFreshInitialization: false }
        )
        value = {
          observedAt: Date.now(),
          generation,
          data: {
            models: result.value
              .filter((model) => model.isEnabled !== false)
              .map((model) => ({
                model: { id: model.value },
                label: model.displayName,
                description: model.description,
                isDefault: model.isDefault,
                efforts: (model.efforts ?? []).map((effort) =>
                  effortOption(effort, undefined, effort === model.defaultEffort)
                )
              })),
            permissions: permissionOptions({ autoAcceptEdits: true, autoReview: true })
          }
        }
        if (
          generation === pool.generation(key) &&
          pool.current(key) === result.session &&
          !result.session.retired
        ) {
          modelCache.delete(key)
          modelCache.set(key, value)
          while (modelCache.size > 16) {
            const oldest = modelCache.keys().next().value
            if (oldest === undefined) break
            modelCache.delete(oldest)
          }
        }
      }
      return capabilityReady(context, 'read', value.data, value.observedAt)
    } catch (error) {
      return {
        ...capabilityReady(context, 'read', { models: [], permissions: permissionOptions({ autoAcceptEdits: true, autoReview: true }) }),
        state: 'degraded' as const,
        reason: String((error as Error).message)
      }
    }
  }

  return {
    skills,
    commands,
    runControls,
    invalidate(key) {
      skillCache.delete(key)
      commandCache.delete(key)
      modelCache.delete(key)
    },
    dispose() {
      skillCache.clear()
      commandCache.clear()
      modelCache.clear()
    }
  }
}
