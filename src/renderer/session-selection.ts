import type { ProjectMeta, SessionMeta } from './env'

export function firstSessionInProject(projects: ProjectMeta[], cwd: string): SessionMeta | null {
  return projects.find((p) => p.cwd === cwd)?.sessions[0] ?? null
}
