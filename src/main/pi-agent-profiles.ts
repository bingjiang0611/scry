import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { providerIdForAgentId } from '../shared/runtime'
import type { DetectedAgent } from './claude-locate'

export interface PiAgentProfile {
  id: string
  label: string
  executable: string
}

const validProfile = (value: unknown): value is PiAgentProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const profile = value as Partial<PiAgentProfile>
  return typeof profile.id === 'string' && /^pi:[a-f0-9]{16}$/.test(profile.id) &&
    typeof profile.label === 'string' && profile.label.length > 0 && profile.label.length <= 120 &&
    typeof profile.executable === 'string' && profile.executable.startsWith('/') && profile.executable.length <= 4_096
}

// Picker equivalence uses canonical launchers, not labels or versions. Keep IDs intact:
// historical sessions still resolve their saved profile independently of discovery.
export async function canonicalizePiAgentPaths(agents: DetectedAgent[]): Promise<DetectedAgent[]> {
  return Promise.all(agents.map(async (agent) => {
    if (providerIdForAgentId(agent.id) !== 'pi') return agent
    try {
      return { ...agent, path: await realpath(agent.path) }
    } catch {
      // Discovery can race with an uninstall. Preserve the entry and its health evidence.
      return agent
    }
  }))
}

// Session history persists profile IDs, so profiles sharing a launcher remain distinct.
export function undetectedPiProfiles(profiles: PiAgentProfile[], detected: Array<{ id: string }>): PiAgentProfile[] {
  const detectedIds = new Set(detected.map((agent) => agent.id))
  return profiles.filter((profile) => !detectedIds.has(profile.id))
}

export function piProfileForExecutable(executable: string): PiAgentProfile {
  const canonical = realpathSync(executable)
  const stat = lstatSync(canonical)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Pi Agent launcher 必须是普通文件')
  accessSync(canonical, constants.X_OK)
  const name = basename(canonical)
  return {
    id: `pi:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`,
    label: name === 'pi' ? 'Pi' : `Pi · ${name}`,
    executable: canonical
  }
}

export function createPiAgentProfileStore(userDataDir: string) {
  const file = join(userDataDir, 'pi-agent-profiles.json')
  const load = (): PiAgentProfile[] => {
    if (!existsSync(file)) return []
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(value) || !value.every(validProfile)) throw new Error('Pi Agent Profile 索引损坏')
    return value
  }
  const save = (profiles: PiAgentProfile[]): void => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, `${JSON.stringify(profiles)}\n`)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temp, file)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temp) } catch { /* temp may not exist */ }
      throw error
    }
  }
  const add = (profile: PiAgentProfile): PiAgentProfile => {
    if (!validProfile(profile)) throw new Error('无效的 Pi Agent Profile')
    save([profile, ...load().filter((item) => item.id !== profile.id)])
    return profile
  }
  const remove = (id: string): void => save(load().filter((profile) => profile.id !== id))
  const resolve = (id: string): PiAgentProfile | undefined => load().find((profile) => profile.id === id)
  return { load, add, remove, resolve }
}
