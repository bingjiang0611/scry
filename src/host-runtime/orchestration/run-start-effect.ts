import type { RunSubmitPayload } from './orchestrator-commands'

/** Payload of the `provider.run.start` effect; kept out of `orchestrator.ts` for its size budget. */
export function buildRunStartEffectPayload(p: RunSubmitPayload): Record<string, unknown> {
  return {
    runId: p.runId,
    sessionKey: p.sessionKey,
    provider: p.provider,
    profile: p.profile,
    cwd: p.cwd,
    ...(p.shadowOnly ? { shadowOnly: true } : {}),
    ...(p.body
      ? p.body.storage === 'inline'
        ? { body: { storage: 'inline', sha256: p.body.sha256, bytes: p.body.bytes, inline: p.body.inline } }
        : { body: { storage: 'external', sha256: p.body.sha256, bytes: p.body.bytes } }
      : {})
  }
}
