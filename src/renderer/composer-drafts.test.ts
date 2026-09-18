import { describe, expect, it } from 'vitest'
import { composerDraftKey, readComposerDrafts, updateComposerDraft, writeComposerDrafts, type ComposerDraft } from './composer-drafts'

class MemoryStorage {
  value: string | null = null
  getItem(): string | null { return this.value }
  setItem(_key: string, value: string): void { this.value = value }
  removeItem(): void { this.value = null }
}

const attachment = (name: string) => ({
  id: `id-${name}`,
  previewUrl: `blob:${name}`,
  kind: 'image' as const,
  name,
  mimeType: 'image/png' as const,
  dataBase64: 'aGVsbG8=',
  size: 5
})

describe('composer drafts', () => {
  it('keys drafts by provider, profile, workspace and session', () => {
    expect(composerDraftKey({ providerId: 'codex', cwd: '/a', sessionId: 'one' }))
      .not.toBe(composerDraftKey({ providerId: 'codex', cwd: '/a', sessionId: 'two' }))
    expect(composerDraftKey({ providerId: 'codex', agentProfileId: 'p', cwd: '/a' }))
      .not.toBe(composerDraftKey({ providerId: 'codex', cwd: '/a' }))
  })

  it('round-trips raw text and attachments without persisting blob URLs', () => {
    const storage = new MemoryStorage()
    const drafts = new Map<string, ComposerDraft>([['key', { input: 'draft text', attachments: [attachment('a.png')] }]])
    writeComposerDrafts(storage, drafts)
    expect(storage.value).toContain('aGVsbG8=')
    expect(storage.value).not.toContain('blob:a.png')
    const restored = readComposerDrafts(storage).get('key')
    expect(restored?.input).toBe('draft text')
    expect(restored?.attachments[0]).toMatchObject({ name: 'a.png', dataBase64: 'aGVsbG8=' })
    expect(restored?.attachments[0].previewUrl).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('drops malformed storage and evicts least-recently-updated drafts', () => {
    const storage = new MemoryStorage()
    storage.value = '{broken'
    expect(readComposerDrafts(storage).size).toBe(0)
    let drafts: ReadonlyMap<string, ComposerDraft> = new Map()
    const evicted: string[] = []
    for (let index = 0; index < 34; index++) {
      const result = updateComposerDraft(drafts, `k${index}`, () => ({ input: `v${index}`, attachments: [] }))
      drafts = result.drafts
      evicted.push(...result.evicted.map((draft) => draft.input))
    }
    expect(drafts.size).toBe(32)
    expect(evicted).toEqual(['v0', 'v1'])
  })
})
