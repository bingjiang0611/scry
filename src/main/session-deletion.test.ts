import { describe, expect, it, vi } from 'vitest'
import { deleteOwnedSessionData } from './session-deletion'

describe('owned session deletion', () => {
  it('uses run ids discovered by SQLite and removes catalog last', async () => {
    const order: string[] = []
    const result = await deleteOwnedSessionData(['run-archive'], {
      resolveRunIds: () => ({ status: 'ready', runIds: ['run-archive', 'run-db'] }),
      deleteDatabase: () => {
        order.push('database')
        return { status: 'deleted', runIds: ['run-archive', 'run-db'] }
      },
      deleteUsage: () => {
        order.push('usage')
        return { preservedInvalid: 0 }
      },
      deleteAttachments: (runId) => {
        order.push(`attachments:${runId}`)
        return {}
      },
      deleteTranscripts: () => {
        order.push('transcripts')
        return { failed: [] }
      },
      deleteCatalog: () => order.push('catalog')
    })
    expect(result.ok).toBe(true)
    expect(order.at(-1)).toBe('catalog')
    expect(order.indexOf('transcripts')).toBeLessThan(order.indexOf('database'))
    expect(order).toEqual(expect.arrayContaining(['attachments:run-archive', 'attachments:run-db']))
    expect(result.retained).toContain('workspace .scry/ canonical turn evidence')
  })

  it('keeps the catalog retry handle when any owned store fails', async () => {
    const deleteCatalog = vi.fn()
    const deleteTranscripts = vi.fn(() => ({ failed: [] }))
    const result = await deleteOwnedSessionData(['run-1'], {
      resolveRunIds: () => ({ status: 'ready', runIds: ['run-1'] }),
      deleteDatabase: () => ({ status: 'deleted', runIds: ['run-1'] }),
      deleteUsage: () => { throw new Error('disk full') },
      deleteAttachments: () => ({}),
      deleteTranscripts,
      deleteCatalog
    })
    expect(result).toMatchObject({ ok: false, reason: 'partial_failure' })
    expect(result.failed).toContainEqual({ store: 'usage', error: 'disk full' })
    expect(deleteTranscripts).not.toHaveBeenCalled()
    expect(deleteCatalog).not.toHaveBeenCalled()
  })

  it('keeps database run-id discovery available when an attachment cleanup must be retried', async () => {
    let databasePresent = true
    let attachmentAttempts = 0
    const run = () => deleteOwnedSessionData([], {
      resolveRunIds: () => ({ status: databasePresent ? 'ready' : 'not_present', runIds: databasePresent ? ['run-db-only'] : [] }),
      deleteDatabase: () => {
        databasePresent = false
        return { status: 'deleted', runIds: ['run-db-only'] }
      },
      deleteUsage: () => ({ preservedInvalid: 0 }),
      deleteAttachments: (runId) => {
        expect(runId).toBe('run-db-only')
        attachmentAttempts++
        return attachmentAttempts === 1 ? { failed: 'busy' } : {}
      },
      deleteTranscripts: () => ({ failed: [] }),
      deleteCatalog: () => {}
    })
    await expect(run()).resolves.toMatchObject({ ok: false, reason: 'partial_failure' })
    expect(databasePresent).toBe(true)
    await expect(run()).resolves.toMatchObject({ ok: true })
    expect(databasePresent).toBe(false)
    expect(attachmentAttempts).toBe(2)
  })

  it('stops before destructive work when a candidate run id belongs to another session', async () => {
    const deleteUsage = vi.fn()
    const deleteDatabase = vi.fn()
    const result = await deleteOwnedSessionData(['foreign-run'], {
      resolveRunIds: () => ({ status: 'ready', runIds: [], conflicts: ['foreign-run'] }),
      deleteDatabase,
      deleteUsage: (runIds) => {
        deleteUsage(runIds)
        return { preservedInvalid: 0 }
      },
      deleteAttachments: () => ({}),
      deleteTranscripts: () => ({ failed: [] }),
      deleteCatalog: () => {}
    })
    expect(result).toMatchObject({ ok: false, reason: 'partial_failure' })
    expect(result.failed[0].store).toBe('run-id ownership')
    expect(deleteUsage).not.toHaveBeenCalled()
    expect(deleteDatabase).not.toHaveBeenCalled()
  })

  it('retains unattributed corrupt usage rows without blocking deletion of attributed session stores', async () => {
    const deleteCatalog = vi.fn()
    const result = await deleteOwnedSessionData(['run-1'], {
      resolveRunIds: () => ({ status: 'ready', runIds: ['run-1'] }),
      deleteDatabase: () => ({ status: 'deleted', runIds: ['run-1'] }),
      deleteUsage: () => ({ preservedInvalid: 1 }),
      deleteAttachments: () => ({}),
      deleteTranscripts: () => ({ failed: [] }),
      deleteCatalog
    })
    expect(result).toMatchObject({ ok: true })
    expect(result.retained).toContain('1 行无法归属的损坏 usage 记录')
    expect(deleteCatalog).toHaveBeenCalledOnce()
  })

  it('keeps all retry handles when managed recovery artifacts cannot be removed', async () => {
    const deleteUsage = vi.fn()
    const deleteCatalog = vi.fn()
    const result = await deleteOwnedSessionData(['run-1'], {
      resolveRunIds: () => ({ status: 'ready', runIds: ['run-1'] }),
      deleteManaged: async () => ({ failed: [{ path: 'managed-turn-progress/run-1.json', error: 'busy' }] }),
      deleteDatabase: () => ({ status: 'deleted', runIds: ['run-1'] }),
      deleteUsage: () => { deleteUsage(); return { preservedInvalid: 0 } },
      deleteAttachments: () => ({}),
      deleteTranscripts: () => ({ failed: [] }),
      deleteCatalog
    })
    expect(result).toMatchObject({ ok: false, reason: 'partial_failure' })
    expect(deleteUsage).not.toHaveBeenCalled()
    expect(deleteCatalog).not.toHaveBeenCalled()
  })

  it('propagates transcript partial failure and preserves database plus catalog retry handles', async () => {
    const deleteDatabase = vi.fn(() => ({ status: 'deleted' as const, runIds: ['run-1'] }))
    const deleteCatalog = vi.fn()
    const result = await deleteOwnedSessionData(['run-1'], {
      resolveRunIds: () => ({ status: 'ready', runIds: ['run-1'] }),
      deleteDatabase,
      deleteUsage: () => ({ preservedInvalid: 0 }),
      deleteAttachments: () => ({}),
      deleteTranscripts: () => ({ failed: [{ path: 'legacy', error: 'corrupt' }] }),
      deleteCatalog
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'partial_failure',
      failed: [{ store: 'legacy', error: 'corrupt' }]
    })
    expect(deleteDatabase).not.toHaveBeenCalled()
    expect(deleteCatalog).not.toHaveBeenCalled()
  })
})
