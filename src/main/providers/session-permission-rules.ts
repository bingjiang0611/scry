import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SessionPermissionRule {
  toolName: string
  ruleContent: string
}

const MAX_SESSIONS = 200
const MAX_RULES_PER_SESSION = 100
const MAX_TEXT = 240

/**
 * A2: the daemon persists accepted "本会话" rules so they survive the Provider process. Claude and
 * Qoder CLIs exit with each run, so a rule that only reached the process disappears with it; the
 * durable copy is the source when the session is started or resumed again.
 */
export class SessionPermissionRuleStore {
  readonly #path: string
  #rules: Record<string, SessionPermissionRule[]> | undefined

  constructor(path: string) {
    this.#path = path
  }

  static inUserData(userDataDir: string): SessionPermissionRuleStore {
    return new SessionPermissionRuleStore(join(userDataDir, 'session-permission-rules.json'))
  }

  rules(sessionId: string | undefined): SessionPermissionRule[] {
    if (!sessionId) return []
    return this.#load()[sessionId] ?? []
  }

  /** Records exact, wildcard-free rules; anything else is ignored rather than guessed. */
  record(sessionId: string, rules: readonly SessionPermissionRule[]): void {
    if (!sessionId) return
    const accepted = rules.filter(isExactRule)
    if (accepted.length === 0) return
    const all = this.#load()
    const merged = [...(all[sessionId] ?? [])]
    for (const rule of accepted) {
      if (!merged.some((existing) => existing.toolName === rule.toolName && existing.ruleContent === rule.ruleContent)) {
        merged.push(rule)
      }
    }
    const keys = Object.keys(all)
    if (!keys.includes(sessionId) && keys.length >= MAX_SESSIONS) {
      // Bound the file: drop the oldest inserted session, never the one being written.
      const [oldest] = keys
      if (oldest !== undefined) delete all[oldest]
    }
    all[sessionId] = merged.slice(-MAX_RULES_PER_SESSION)
    this.#save(all)
  }

  clear(sessionId: string): void {
    const all = this.#load()
    if (!(sessionId in all)) return
    delete all[sessionId]
    this.#save(all)
  }

  #load(): Record<string, SessionPermissionRule[]> {
    if (this.#rules) return this.#rules
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown
      const result: Record<string, SessionPermissionRule[]> = {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!Array.isArray(value)) continue
          const rules = value.filter(isExactRule)
          if (rules.length > 0) result[sessionId] = rules
        }
      }
      this.#rules = result
    } catch {
      this.#rules = {}
    }
    return this.#rules
  }

  #save(all: Record<string, SessionPermissionRule[]>): void {
    this.#rules = all
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(all), { mode: 0o600 })
    renameSync(temp, this.#path)
  }
}

function isExactRule(value: unknown): value is SessionPermissionRule {
  const rule = value as Partial<SessionPermissionRule> | null
  if (!rule || typeof rule.toolName !== 'string' || typeof rule.ruleContent !== 'string') return false
  const toolName = rule.toolName.trim()
  const ruleContent = rule.ruleContent.trim()
  return Boolean(
    toolName &&
    ruleContent &&
    toolName.length <= MAX_TEXT &&
    ruleContent.length <= MAX_TEXT &&
    !toolName.includes('*') &&
    !ruleContent.includes('*')
  )
}

/** SDK allow-list entries (`Tool(rule)`), the shape Claude's `settings.permissions.allow` expects. */
export function permissionAllowEntries(rules: readonly SessionPermissionRule[]): string[] {
  return rules.filter(isExactRule).map((rule) => `${rule.toolName.trim()}(${rule.ruleContent.trim()})`)
}
