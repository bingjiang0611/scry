import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import {
  attachmentSessionRunIds,
  attachmentRunDir,
  deleteRunAttachments,
  hydrateStoredAttachment,
  MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES,
  prepareRunAttachments,
  providerAttachmentPrompt,
  storeAttachmentReference,
  updateRunAttachmentOwner
} from './attachment-store'

const roots: string[] = []
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'scry-attachments-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('attachment store', () => {
  it('appends isolated Steer batches without replacing root or previous attachment bytes', () => {
    const userDataDir = root()
    const image = { kind: 'image' as const, name: 'screen.png', mimeType: 'image/png' as const, dataBase64: png.toString('base64') }
    const [original] = prepareRunAttachments(userDataDir, 'run-steer', [image])
    const [first] = prepareRunAttachments(userDataDir, 'run-steer', [image], undefined, 'message-1')
    const [second] = prepareRunAttachments(userDataDir, 'run-steer', [image], undefined, 'message-2')
    expect(new Set([original.path, first.path, second.path]).size).toBe(3)
    for (const attachment of [original, first, second]) expect(readFileSync(attachment.path)).toEqual(png)
  })

  it('rolls back only a failed Steer batch and rejects path-like batch identities', () => {
    const userDataDir = root()
    const image = { kind: 'image' as const, name: 'screen.png', mimeType: 'image/png' as const, dataBase64: png.toString('base64') }
    const [original] = prepareRunAttachments(userDataDir, 'run-steer', [image])
    expect(() => prepareRunAttachments(userDataDir, 'run-steer', [image, { ...image, dataBase64: 'aGVsbG8=' }], undefined, 'message-1')).toThrow('不匹配')
    expect(readFileSync(original.path)).toEqual(png)
    expect(readdirSync(attachmentRunDir(userDataDir, 'run-steer')!)).toEqual(['01-screen.png'])
    expect(() => prepareRunAttachments(userDataDir, 'run-steer', [image], undefined, '../../escape')).toThrow('批次身份非法')
  })

  it('does not expose native Pi image paths that would make the agent read the same attachment again', () => {
    const attachment = {
      kind: 'image' as const,
      name: 'screen.png',
      mimeType: 'image/png' as const,
      dataBase64: png.toString('base64'),
      size: png.byteLength,
      path: '/user-data/attachments/run-1/01-screen.png'
    }
    expect(providerAttachmentPrompt('pi', ' inspect this ', [attachment])).toBe(' inspect this ')
    expect(providerAttachmentPrompt('codex', '  code\n', [])).toBe('  code\n')
    expect(providerAttachmentPrompt('qoder', ' inspect this ', [attachment])).toMatch(/^ inspect this \n\nScry/)
    expect(providerAttachmentPrompt('qoder', ' inspect this ', [attachment])).toContain('local copy: /user-data/attachments/run-1/01-screen.png')
  })

  it('persists validated images and stores only a controlled blob id in archive metadata', () => {
    const userDataDir = root()
    const [prepared] = prepareRunAttachments(userDataDir, 'run-1', [{
      kind: 'image',
      name: '../screen.png',
      mimeType: 'image/png',
      dataBase64: png.toString('base64')
    }])
    expect(existsSync(prepared.path)).toBe(true)
    expect(storeAttachmentReference(userDataDir, 'run-1', prepared)).toEqual(expect.objectContaining({
      storage: 'blob',
      blobId: '01-screen.png'
    }))
    expect(JSON.stringify(storeAttachmentReference(userDataDir, 'run-1', prepared))).not.toContain(userDataDir)
  })

  it('persists images beyond the former count and per-image limits', () => {
    const userDataDir = root()
    const large = Buffer.alloc(10 * 1024 * 1024 + 1)
    png.copy(large)
    const prepared = prepareRunAttachments(userDataDir, 'run-large', [
      { kind: 'image', name: 'large.png', mimeType: 'image/png', dataBase64: large.toString('base64') },
      ...Array.from({ length: 8 }, (_, index) => ({
        kind: 'image' as const,
        name: `${index}.png`,
        mimeType: 'image/png' as const,
        dataBase64: png.toString('base64')
      }))
    ])
    expect(prepared).toHaveLength(9)
    expect(prepared[0].size).toBe(large.byteLength)
  })

  it('persists exact session ownership independently from archive and usage evidence', () => {
    const userDataDir = root()
    prepareRunAttachments(userDataDir, 'run-old', [{
      kind: 'image',
      name: 'old.png',
      mimeType: 'image/png',
      dataBase64: png.toString('base64')
    }], { providerId: 'codex', cwd: '/repo' })
    expect(attachmentSessionRunIds(userDataDir, {
      providerId: 'codex', cwd: '/repo', sessionId: 'sess-1'
    })).toEqual([])

    updateRunAttachmentOwner(userDataDir, 'run-old', {
      providerId: 'codex', cwd: '/repo', sessionId: 'sess-1'
    })
    expect(attachmentSessionRunIds(userDataDir, {
      providerId: 'codex', cwd: '/repo', sessionId: 'sess-1'
    })).toEqual(['run-old'])
    expect(attachmentSessionRunIds(userDataDir, {
      providerId: 'codex', cwd: '/repo', sessionId: 'other'
    })).toEqual([])
  })

  it('rolls back the whole run directory when a later attachment write fails', () => {
    const userDataDir = root()
    const runDir = join(userDataDir, 'attachments', 'run-rollback')
    mkdirSync(join(runDir, '02-second.png'), { recursive: true })
    expect(() => prepareRunAttachments(userDataDir, 'run-rollback', [
      { kind: 'image', name: 'first.png', mimeType: 'image/png', dataBase64: png.toString('base64') },
      { kind: 'image', name: 'second.png', mimeType: 'image/png', dataBase64: png.toString('base64') }
    ])).toThrow()
    expect(existsSync(runDir)).toBe(false)
  })

  it('hydrates a valid blob but rejects traversal, symlinks and MIME mismatch', () => {
    const userDataDir = root()
    const runDir = join(userDataDir, 'attachments', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'ok.png'), png)
    writeFileSync(join(runDir, 'wrong.png'), Buffer.from('not png'))
    symlinkSync(join(runDir, 'ok.png'), join(runDir, 'link.png'))
    const budget = { usedBytes: 0, maxBytes: MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES }
    const ref = (blobId: string) => ({ storage: 'blob' as const, kind: 'image' as const, name: blobId, mimeType: 'image/png' as const, blobId })
    expect(hydrateStoredAttachment(userDataDir, 'run-1', ref('ok.png'), budget).attachment?.dataBase64).toBe(png.toString('base64'))
    expect(hydrateStoredAttachment(userDataDir, 'run-1', ref('../ok.png'), budget).attachment).toBeNull()
    expect(hydrateStoredAttachment(userDataDir, 'run-1', ref('link.png'), budget).attachment).toBeNull()
    expect(hydrateStoredAttachment(userDataDir, 'run-1', ref('wrong.png'), budget).attachment).toBeNull()
  })

  it('rejects dot-segment run ids without reading or deleting outside the run directory', () => {
    const userDataDir = root()
    const marker = join(userDataDir, 'marker.txt')
    writeFileSync(marker, 'keep')
    expect(attachmentRunDir(userDataDir, '.')).toBeNull()
    expect(attachmentRunDir(userDataDir, '..')).toBeNull()
    expect(hydrateStoredAttachment(userDataDir, '..', {
      storage: 'blob', kind: 'image', name: 'marker.txt', mimeType: 'image/png', blobId: 'marker.txt'
    }, { usedBytes: 0, maxBytes: MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES }).attachment).toBeNull()
    expect(deleteRunAttachments(userDataDir, '..')).toEqual({ deleted: false })
    expect(existsSync(marker)).toBe(true)
  })

  it('rejects an attachments parent symlink for writes, reads and recursive deletion', () => {
    const userDataDir = root()
    const external = root()
    const externalRun = join(external, 'run-1')
    mkdirSync(userDataDir, { recursive: true })
    mkdirSync(externalRun, { recursive: true })
    writeFileSync(join(externalRun, 'ok.png'), png)
    writeFileSync(join(externalRun, 'marker.txt'), 'keep')
    symlinkSync(external, join(userDataDir, 'attachments'))
    expect(() => prepareRunAttachments(userDataDir, 'run-1', [{
      kind: 'image', name: 'new.png', mimeType: 'image/png', dataBase64: png.toString('base64')
    }])).toThrow('附件根目录不可信')
    expect(hydrateStoredAttachment(userDataDir, 'run-1', {
      storage: 'blob', kind: 'image', name: 'ok.png', mimeType: 'image/png', blobId: 'ok.png'
    }, { usedBytes: 0, maxBytes: MAX_ARCHIVE_ATTACHMENT_HYDRATE_BYTES }).attachment).toBeNull()
    expect(deleteRunAttachments(userDataDir, 'run-1').failed).toContain('不可信')
    expect(existsSync(join(externalRun, 'marker.txt'))).toBe(true)
  })

  it('fails closed when the session hydrate budget is exhausted', () => {
    const userDataDir = root()
    const runDir = join(userDataDir, 'attachments', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'ok.png'), png)
    const result = hydrateStoredAttachment(userDataDir, 'run-1', {
      storage: 'blob', kind: 'image', name: 'ok.png', mimeType: 'image/png', blobId: 'ok.png'
    }, { usedBytes: 0, maxBytes: png.byteLength - 1 })
    expect(result.attachment).toBeNull()
    expect(result.warning).toContain('加载预算')
  })
})
