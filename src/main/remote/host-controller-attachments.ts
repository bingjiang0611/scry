import type { DesktopAttachmentReference, DesktopAttachmentStore } from './desktop-attachments'
import { RemoteRunDenied } from './remote-run-policy'
import type { RemoteIntentAttachment, RemoteIntentRouting } from './host-controller-types'

// Chunked device attachments and their per-intent lifecycle. The store already
// binds every id to the peer that created it; these helpers only add the device
// grant check around it.
export interface AttachmentDeps {
  authorizeDevice(peer: string): void
  store: DesktopAttachmentStore | undefined
}

export function startAttachment(deps: AttachmentDeps, peer: string, input: unknown): Promise<{ status: 'ready' }> {
    deps.authorizeDevice(peer)
    if (!deps.store || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    return deps.store.begin(peer, {
      attachmentId: value.attachmentId as string, intentId: value.intentId as string, name: value.name as string,
      mimeType: value.mimeType as never, size: value.size as number, sha256: value.sha256 as string,
      index: value.index as number, totalCount: value.totalCount as number
    }).then(() => { deps.authorizeDevice(peer); return { status: 'ready' as const } })
}

export function chunkAttachment(deps: AttachmentDeps, peer: string, input: unknown): Promise<{ offset: number }> {
    deps.authorizeDevice(peer)
    if (!deps.store || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    return deps.store.chunk(peer, { attachmentId: value.attachmentId as string, offset: value.offset as number, dataBase64: value.dataBase64 as string }).then((result) => { deps.authorizeDevice(peer); return result })
}

export async function commitAttachment(deps: AttachmentDeps, peer: string, input: unknown): Promise<{ attachment: DesktopAttachmentReference }> {
    deps.authorizeDevice(peer)
    if (!deps.store || !input || typeof input !== 'object') throw new Error('desktop_remote_attachments_unsupported')
    const value = input as Record<string, unknown>
    const attachment = await deps.store.commit(peer, value.attachmentId as string)
    deps.authorizeDevice(peer)
    return { attachment }
}

export async function resolveIntentAttachments(store: DesktopAttachmentStore | undefined, routing: RemoteIntentRouting): Promise<RemoteIntentRouting> {
    const references = (routing.attachments ?? []).filter((item): item is RemoteIntentAttachment & { attachmentId: string; sha256: string } => typeof item.attachmentId === 'string' && typeof item.sha256 === 'string')
    if (references.length === 0) return routing
    if (!store || typeof routing.attachmentPeer !== 'string') throw new RemoteRunDenied('invalid_target')
    const hydrated = await Promise.all((routing.attachments ?? []).map(async (item) => {
      if (!item.attachmentId || !item.sha256) return item
      const loaded = await store!.read({ ...item, peer: routing.attachmentPeer! } as unknown as DesktopAttachmentReference)
      return { ...item, ...loaded } as unknown as RemoteIntentAttachment
    }))
    return { ...routing, attachments: hydrated as RemoteIntentAttachment[] }
}

export async function releaseIntentAttachments(store: DesktopAttachmentStore | undefined, routing: RemoteIntentRouting): Promise<void> {
    if (!store || typeof routing.attachmentPeer !== 'string') return
    await Promise.all((routing.attachments ?? []).filter((item): item is RemoteIntentAttachment & { attachmentId: string } => typeof item.attachmentId === 'string').map((item) => store!.remove(routing.attachmentPeer!, item.attachmentId)))
}
