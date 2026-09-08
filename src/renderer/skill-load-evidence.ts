import type { TraceEvent } from '@shared/trace'

export const INFERRED_SKILL_LOAD_SOURCE = 'user_requested_skill_load'

export function isInferredSkillLoad(event: TraceEvent): boolean {
  const input = event.input as Record<string, unknown> | undefined
  return event.kind === 'skill' && input?.source === INFERRED_SKILL_LOAD_SOURCE
}

/**
 * Some providers implement a user-invoked skill as Read(SKILL.md), not a Skill tool.
 * This is a display projection, not a new provider event or a rewrite of canonical records.
 * Require both explicit invocation intent and a successful matching read; do not promote
 * arbitrary file references, failed reads, or the model merely saying it used a skill.
 */
export function projectRequestedSkillLoads(items: TraceEvent[], userText?: string): TraceEvent[] {
  const command = userText?.trimStart().match(/^\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9._:-]*)(?=\s|$)/)?.[1]
  if (!command) return items
  const explicit = new Set(items.filter((event) => event.kind === 'skill' && event.stage !== 'tool_result').map((event) => event.name))
  const results = new Map<string, TraceEvent>()
  for (const event of items) {
    if (event.stage === 'tool_result' && event.toolUseId) results.set(event.toolUseId, event)
  }
  const loaded = new Set<string>()
  return items.map((event) => {
    if (event.kind !== 'tool' || event.stage === 'tool_result' || event.tool !== 'Read' || !event.toolUseId) return event
    const input = event.input as Record<string, unknown> | undefined
    const path = event.filePath ?? (typeof input?.file_path === 'string' ? input.file_path : undefined)
    if (!path || path.split('/').includes('..')) return event
    const match = path.match(/(?:^|\/)(?:(?<workspace>[^/]+)\/)?\.(?:claude|qoder|agents|pi)\/skills\/(?<skill>[^/]+)\/SKILL\.md$/)
    const name = match?.groups?.skill
    const workspace = match?.groups?.workspace
    if (!name || (command !== name && command !== `${workspace}-${name}`)) return event
    if (explicit.has(name) || explicit.has(command) || loaded.has(name)) return event
    const result = results.get(event.toolUseId)
    if (result?.isError !== false) return event
    if (result.filePath && result.filePath !== path) return event
    loaded.add(name)
    // Reclassify the existing Read for the call breakdown, rather than adding a fake tool
    // call. Preserve id/runId/toolUseId so clicking still opens the original Read evidence.
    return {
      ...event,
      kind: 'skill',
      stage: `skill:${name}`,
      name,
      input: { ...input, source: INFERRED_SKILL_LOAD_SOURCE, evidenceQuality: 'inferred', requestedSkill: command }
    }
  })
}
