/**
 * The error code an execution-target call answers with: a desktop client's own code
 * without its prefix, anything else bounded. Free of the gateway it serves, so the App's
 * execution-target pump uses the same mapping.
 */
export function executionTargetError(error: unknown): { error: string } {
  const raw = String((error as { code?: string })?.code ?? (error as Error)?.message ?? 'error')
  return { error: raw.startsWith('desktop_remote_') ? raw.slice('desktop_remote_'.length) : raw.slice(0, 128) }
}
