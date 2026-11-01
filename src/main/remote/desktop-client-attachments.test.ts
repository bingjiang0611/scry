import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decrypt, setup, ssh } from './desktop-client-fixtures'

describe('DesktopRemoteClient attachment submission fence', () => {
  it('does not persist an unknown intent during upload or after an upload failure', async () => {
    const fixture = await setup()
    let entered!: () => void
    let release!: () => void
    const uploading = new Promise<void>((resolve) => { entered = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    try {
      const pending = await fixture.client.pair({ label: 'images', ssh, invitation: fixture.invitation })
      await fixture.client.finishPairing(pending.connection.id)
      const original = fixture.tlsRequest.getMockImplementation()!
      fixture.tlsRequest.mockImplementation(async (options) => {
        const request = options.request as { op?: string }
        if (request.op === 'desktop') return { desktop: { kind: 'info', protocol: 1, hostId: fixture.host.hostId, execution: 'canonical', attachments: { transport: 'chunked', maxBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, maxCount: 16, chunkBytes: 256 * 1024 } } }
        if (request.op === 'attachmentStart') { entered(); await blocked; throw new Error('network_down') }
        return original(options)
      })
      await fixture.client.connect(pending.connection.id)
      const request = { context: { cwd: '/workspace', providerId: 'claude' }, prompt: '', attachments: [{ kind: 'image' as const, name: 'image.png', mimeType: 'image/png' as const, dataBase64: 'iVBORw0KGgo=' }] }
      const sending = fixture.client.submit(pending.connection.id, request)
      const rejected = expect(sending).rejects.toThrow('attachment_transfer_failed')
      await uploading
      await expect(fixture.client.submit(pending.connection.id, request)).rejects.toThrow('submission_in_progress')
      expect(JSON.parse(decrypt(await readFile(join(fixture.directory, 'desktop-client.state')))).intents).toEqual([])
      release()
      await rejected
      await expect(fixture.client.intents(pending.connection.id)).resolves.toEqual([])
      expect(fixture.tlsRequest.mock.calls.some(([options]) => (options.request as { op?: string }).op === 'submit')).toBe(false)
    } finally { release(); await fixture.client.dispose(); await rm(fixture.directory, { recursive: true, force: true }) }
  })
})
