export interface SessionAttentionRef {
  providerId: string
  agentProfileId?: string
  cwd: string
  sessionId: string
}

export interface SessionAttentionSnapshot {
  revision: number
  unreadSessionKeys: string[]
}

export function sessionAttentionKey(ref: SessionAttentionRef): string {
  return `${ref.providerId}\0${ref.agentProfileId ?? ''}\0${ref.cwd}\0${ref.sessionId}`
}
