import { rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { LEGACY_REDACTION_VERSION, MAX_BATCH_BYTES, MAX_BATCH_RECORDS, MAX_RECORD_BYTES } from './constants.js'
import { readReceipt, retainEnvelope } from './custody/index.js'
import { UploadError } from './errors.js'
import { retryAt } from './retry.js'
import { recordUploadDisabled } from './scry.js'
import { dataRoot, digest, uploadRoot } from './storage.js'
import type { OutboxEnvelope } from './types.js'
import { deadLetter, loadEnvelope, outboxPaths } from './uploader-custody.js'
import { syncDirectory } from './util.js'

async function quarantineOutbox(workspace: string, path: string, reason = 'invalid'): Promise<void> {
  const target = join(uploadRoot(workspace), 'dead-letter', `${Date.now()}-${reason}-${basename(path)}`)
  await rename(path, target)
  await syncDirectory(dirname(target))
  await syncDirectory(dirname(path))
}
export async function nextBatch(
  workspace: string,
  deferred: Set<string>,
  summary: { deadLettered: number }
): Promise<Array<[string, OutboxEnvelope]>> {
  const batch: Array<[string, OutboxEnvelope]> = []
  let size = 0
  for (const path of await outboxPaths(workspace)) {
    if (deferred.has(path)) continue
    const namedId = basename(path).match(/^\d{20}-([a-f0-9]{32,64})\.json$/)?.[1]
    let receipt = namedId ? await readReceipt(uploadRoot(workspace), namedId) : null
    if (receipt?.status === 'skipped_disabled') continue
    let envelope: OutboxEnvelope
    try {
      envelope = await loadEnvelope(path, !(receipt?.bodyPruneStartedAt || receipt?.bodyPrunedAt))
    } catch (error) {
      if (error instanceof UploadError && error.code === 'invalid_outbox') {
        await quarantineOutbox(workspace, path)
        summary.deadLettered++
        continue
      }
      throw error
    }
    if (receipt && receipt.status !== 'pending') {
      if ((receipt.bodyPruneStartedAt || receipt.bodyPrunedAt) && digest(envelope.record) !== receipt.sha256) {
        await quarantineOutbox(workspace, path, 'retired-pending')
        summary.deadLettered++
        continue
      } else {
        await unlink(path)
      }
      await syncDirectory(dirname(path))
      continue
    }
    // Older discovery could leave an outbox without custody. Keep its exact
    // submitted bytes; legacy payloads may also differ from canonical custody.
    if (!receipt || envelope.redactionVersion === LEGACY_REDACTION_VERSION)
      receipt = await retainEnvelope(workspace, envelope)
    if (receipt.status !== 'pending') continue
    if (!receipt.releasedAt && await recordUploadDisabled(dataRoot(workspace), envelope.recordId)) {
      await retainEnvelope(workspace, envelope, true)
      continue
    }
    if (retryAt(envelope) > Date.now()) {
      deferred.add(path)
      continue
    }
    if (envelope.recordBytes > MAX_RECORD_BYTES) {
      await deadLetter(workspace, path, envelope, 'rejected', 'oversize_record')
      summary.deadLettered++
      continue
    }
    if (
      batch.length &&
      (batch.length >= MAX_BATCH_RECORDS ||
        size + envelope.recordBytes > MAX_BATCH_BYTES ||
        envelope.redactionVersion !== batch[0][1].redactionVersion)
    )
      break
    batch.push([path, envelope])
    size += envelope.recordBytes
  }
  return batch
}
