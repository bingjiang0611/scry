import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AgentPermissionMode } from '../../shared/runtime-types'

export interface DelegationCallerContext {
  runId: string
  sessionKey: string
  bindingId: string
  actor: string
  principal: string
  via: string
  provider: string
  profile: string | null
  cwd: string
  permissionMode: AgentPermissionMode
  token: string
}

export interface IssueDelegationCredentialInput {
  runId: string
  sessionKey: string
  bindingId: string
  principal: string
  provider: string
  profile: string | null
  cwd: string
  permissionMode: AgentPermissionMode
}

/**
 * In-memory per-run credential store for P6 orchestration MCP (security §S4 / D16):
 * - 32-byte random bearer token (never persisted; only `via` UUID is logged).
 * - Bound to a single calling run; revoked immediately on run terminal/stop/exit.
 * - No idle expiry: a parent run waiting on subtasks keeps its credential for its lifetime.
 */
export class DelegationCredentialStore {
  readonly #byRunId = new Map<string, DelegationCallerContext>()

  issue(input: IssueDelegationCredentialInput): DelegationCallerContext {
    const via = randomUUID()
    const token = randomBytes(32).toString('hex')
    const ctx: DelegationCallerContext = {
      runId: input.runId,
      sessionKey: input.sessionKey,
      bindingId: input.bindingId,
      actor: `agent:${input.sessionKey}#${input.bindingId}`,
      principal: input.principal,
      via,
      provider: input.provider,
      profile: input.profile,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      token
    }
    this.#byRunId.set(input.runId, ctx)
    return ctx
  }

  verifyRun(runId: string): DelegationCallerContext | undefined {
    return this.#byRunId.get(runId)
  }

  verifyBearerToken(presentedToken: string): DelegationCallerContext | undefined {
    if (!presentedToken || presentedToken.length !== 64) return undefined
    const presentedBuf = Buffer.from(presentedToken, 'utf8')
    let matched: DelegationCallerContext | undefined
    for (const ctx of this.#byRunId.values()) {
      const expectedBuf = Buffer.from(ctx.token, 'utf8')
      if (expectedBuf.length === presentedBuf.length && timingSafeEqual(expectedBuf, presentedBuf)) {
        matched = ctx
      }
    }
    return matched
  }

  revokeRun(runId: string): boolean {
    return this.#byRunId.delete(runId)
  }

  clear(): void {
    this.#byRunId.clear()
  }
}
