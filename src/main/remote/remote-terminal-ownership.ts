// G3 terminal ownership seam. A managed terminal can be driven by the local
// user or by a remote device, but never ambiguously at once. This layers three
// invariants on top of a terminal id, independent of node-pty so they are
// testable in isolation:
//
//   - Single writer: exactly one owner holds the current writer generation.
//   - No input replay: every write must carry the current generation. A write
//     captured under a previous generation (a re-attach or an ownership
//     takeover) is refused, so replayed keystrokes cannot reach the PTY.
//   - Owner-aware cleanup: a remote device disconnecting releases only its own
//     terminals; the local user's terminals (and other devices') are untouched.
//     Local application quit stays a separate path in TerminalManager.

export type TerminalOwner =
  | { kind: 'local' }
  | { kind: 'remote'; deviceId: string }

export interface WriterToken {
  id: string
  generation: number
}

const LOCAL: TerminalOwner = { kind: 'local' }

function sameOwner(a: TerminalOwner, b: TerminalOwner): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'local' || a.deviceId === (b as { deviceId: string }).deviceId
}

function ownerKey(owner: TerminalOwner): string {
  return owner.kind === 'local' ? 'local' : `remote:${owner.deviceId}`
}

export class RemoteTerminalOwnershipError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'RemoteTerminalOwnershipError'
    this.code = code
  }
}

interface Record { owner: TerminalOwner; generation: number }

export class RemoteTerminalOwnership {
  #terminals = new Map<string, Record>()

  // Attach (or take over) a terminal, bumping the writer generation so any token
  // minted before this call is now stale. Returns the only token that may write.
  attach(id: string, owner: TerminalOwner = LOCAL): WriterToken {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
      throw new RemoteTerminalOwnershipError('invalid_terminal_id')
    }
    if (owner.kind === 'remote' && (typeof owner.deviceId !== 'string' || owner.deviceId.length === 0)) {
      throw new RemoteTerminalOwnershipError('invalid_owner')
    }
    const existing = this.#terminals.get(id)
    const generation = (existing?.generation ?? 0) + 1
    this.#terminals.set(id, { owner, generation })
    return { id, generation }
  }

  // Authorize a write. Fails closed unless the token matches the current
  // generation (no replay) and is presented by the current owner.
  authorizeWrite(token: WriterToken, owner: TerminalOwner = LOCAL): void {
    if (!token || typeof token.id !== 'string' || !Number.isSafeInteger(token.generation)) {
      throw new RemoteTerminalOwnershipError('invalid_writer_token')
    }
    const record = this.#terminals.get(token.id)
    if (!record) throw new RemoteTerminalOwnershipError('unknown_terminal')
    // Generation is the primary anti-replay fence: a token minted before the
    // latest attach/takeover is refused regardless of who presents it.
    if (record.generation !== token.generation) throw new RemoteTerminalOwnershipError('stale_writer')
    if (!sameOwner(record.owner, owner)) throw new RemoteTerminalOwnershipError('not_owner')
  }

  ownerOf(id: string): TerminalOwner | undefined {
    return this.#terminals.get(id)?.owner
  }

  ownedBy(owner: TerminalOwner): string[] {
    const ids: string[] = []
    for (const [id, record] of this.#terminals) if (sameOwner(record.owner, owner)) ids.push(id)
    return ids
  }

  release(id: string): void {
    this.#terminals.delete(id)
  }

  // Owner-aware cleanup: release exactly the terminals owned by one owner (e.g.
  // a remote device that disconnected) and return their ids so the caller can
  // close the matching PTYs. Never touches another owner's terminals.
  releaseOwnedBy(owner: TerminalOwner): string[] {
    const ids = this.ownedBy(owner)
    for (const id of ids) this.#terminals.delete(id)
    return ids
  }

  describe(): { terminals: number; owners: string[] } {
    const owners = new Set<string>()
    for (const record of this.#terminals.values()) owners.add(ownerKey(record.owner))
    return { terminals: this.#terminals.size, owners: [...owners] }
  }
}
