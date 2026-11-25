
export function claudeTranscriptUsageKey(input: {
  messageId?: string | undefined
  requestId?: string | undefined
}): string | undefined {
  const messageId = typeof input.messageId === 'string' && input.messageId ? input.messageId : ''
  const requestId = typeof input.requestId === 'string' && input.requestId ? input.requestId : ''
  if (!messageId && !requestId) return undefined
  return JSON.stringify([messageId, requestId])
}

export class TranscriptUsageDedupe {
  readonly #seen = new Set<string>()
  #duplicates = 0
  #unkeyed = 0

  admit(key: string | undefined): boolean {
    if (key === undefined) {
      this.#unkeyed += 1
      return true
    }
    if (this.#seen.has(key)) {
      this.#duplicates += 1
      return false
    }
    this.#seen.add(key)
    return true
  }

  get duplicatesDropped(): number {
    return this.#duplicates
  }

  get unkeyedAdmitted(): number {
    return this.#unkeyed
  }
}

export function codexLastUsageSignature(lastTokenUsage: unknown): string | null {
  if (typeof lastTokenUsage !== 'object' || lastTokenUsage === null || Array.isArray(lastTokenUsage)) return null
  const entries = Object.entries(lastTokenUsage as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => [key, value as number] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return null
  return JSON.stringify(entries)
}

export class CodexUsageDeltaFilter {
  #previous: string | null = null
  #duplicates = 0

  admit(lastTokenUsage: unknown): boolean {
    const signature = codexLastUsageSignature(lastTokenUsage)
    if (signature === null) return true
    if (signature === this.#previous) {
      this.#duplicates += 1
      return false
    }
    this.#previous = signature
    return true
  }

  get duplicatesDropped(): number {
    return this.#duplicates
  }
}
