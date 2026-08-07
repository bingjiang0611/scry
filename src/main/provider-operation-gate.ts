export type ProviderOperationLease =
  | { ok: true; release(): void }
  | { ok: false; blockedBy: 'authentication' | 'operation' }

export class ProviderOperationGate {
  private readonly authentications = new Set<string>()
  private readonly operations = new Map<string, number>()

  acquireAuthentication(key: string): ProviderOperationLease {
    if (this.authentications.has(key)) return { ok: false, blockedBy: 'authentication' }
    if ((this.operations.get(key) ?? 0) > 0) return { ok: false, blockedBy: 'operation' }
    this.authentications.add(key)
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        this.authentications.delete(key)
      }
    }
  }

  acquireOperation(key: string): ProviderOperationLease {
    if (this.authentications.has(key)) return { ok: false, blockedBy: 'authentication' }
    this.operations.set(key, (this.operations.get(key) ?? 0) + 1)
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        const remaining = (this.operations.get(key) ?? 1) - 1
        if (remaining === 0) this.operations.delete(key)
        else this.operations.set(key, remaining)
      }
    }
  }
}
