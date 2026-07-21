import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHead } from './app-store'
import { readSkillMeta } from './skill-meta'

export interface SkillConfigItem {
  name: string
  dir: string
  scope: string
  description: string
  enabled: boolean
}

export function listSkillsIn(dir: string, scope: string): Array<Omit<SkillConfigItem, 'enabled'>> {
  if (!existsSync(dir)) return []
  let dirs: string[]
  try {
    dirs = readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<Omit<SkillConfigItem, 'enabled'>> = []
  for (const d of dirs) {
    const md = join(dir, d, 'SKILL.md')
    if (!existsSync(md)) continue
    const meta = readSkillMeta(readHead(md, 4096))
    out.push({ name: meta.name || d, dir: d, scope, description: (meta.description || '').slice(0, 160) })
  }
  return out
}

const userSettingsLocal = (homeDir: string): string => join(homeDir, '.claude', 'settings.local.json')

function readSkillOverrides(file: string): Record<string, string> {
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      if (j && typeof j.skillOverrides === 'object' && j.skillOverrides) return j.skillOverrides
    }
  } catch {
    /* damaged/missing settings.local.json means no override */
  }
  return {}
}

function hasSkillOverridesKey(file: string): boolean {
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      return !!j && typeof j.skillOverrides === 'object' && j.skillOverrides !== null
    }
  } catch {
    /* ignore */
  }
  return false
}

export function activeOverridesFile(cwd: string | undefined, homeDir: string): string {
  if (cwd) {
    const projFile = join(cwd, '.claude', 'settings.local.json')
    if (Object.keys(readSkillOverrides(projFile)).length > 0 || hasSkillOverridesKey(projFile)) return projFile
  }
  return userSettingsLocal(homeDir)
}

export function isSkillOff(name: string, cwd: string | undefined, homeDir: string): boolean {
  return readSkillOverrides(activeOverridesFile(cwd, homeDir))[name] === 'off'
}

function writeOverride(file: string, name: string, off: boolean): void {
  let obj: Record<string, unknown> = {}
  try {
    if (existsSync(file)) obj = JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch {
    obj = {}
  }
  const ov = (obj.skillOverrides && typeof obj.skillOverrides === 'object' ? obj.skillOverrides : {}) as Record<
    string,
    string
  >
  if (off) ov[name] = 'off'
  else if (name in ov) delete ov[name]
  else return
  obj.skillOverrides = ov
  try {
    writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
  } catch {
    /* ignore */
  }
}

export function setSkillEnabled(name: string, enabled: boolean, cwd: string | undefined, homeDir: string): void {
  writeOverride(activeOverridesFile(cwd, homeDir), name, !enabled)
}

export function listSkills(cwd: string | undefined, homeDir: string): SkillConfigItem[] {
  const proj = cwd ? listSkillsIn(join(cwd, '.claude', 'skills'), 'project') : []
  const user = listSkillsIn(join(homeDir, '.claude', 'skills'), 'user')
  return [...proj, ...user].map((s) => ({ ...s, enabled: !isSkillOff(s.name, cwd, homeDir) }))
}

export function computeEnabledSkills(cwd: string | undefined, homeDir: string): string[] | undefined {
  const all = [
    ...(cwd ? listSkillsIn(join(cwd, '.claude', 'skills'), 'project') : []),
    ...listSkillsIn(join(homeDir, '.claude', 'skills'), 'user')
  ]
  if (all.length === 0) return undefined
  if (!all.some((s) => isSkillOff(s.name, cwd, homeDir))) return undefined
  return all.filter((s) => !isSkillOff(s.name, cwd, homeDir)).map((s) => s.name)
}
