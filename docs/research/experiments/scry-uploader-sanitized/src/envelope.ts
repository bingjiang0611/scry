import { basename } from 'node:path'
import type { OutboxEnvelope } from './types.js'
import { UploadError } from './errors.js'
import { digest, recordFilename } from './storage.js'
import { LEGACY_REDACTION_VERSION } from './constants.js'
import { object } from './util.js'

const RECORD_ID_RE = /^[a-f0-9]{32,64}$/

export function validateEnvelope(value: unknown, path: string): OutboxEnvelope {
  const envelope = object(value)
  if (
    !envelope ||
    envelope.version !== 1 ||
    typeof envelope.record !== 'string' ||
    !Number.isSafeInteger(envelope.sequence) ||
    Number(envelope.sequence) < 1 ||
    typeof envelope.recordId !== 'string' ||
    !RECORD_ID_RE.test(envelope.recordId) ||
    basename(path) !== recordFilename(Number(envelope.sequence), envelope.recordId) ||
    typeof envelope.workspaceId !== 'string' ||
    !envelope.workspaceId.trim()
  )
    throw new UploadError('invalid_outbox', basename(path))
  if (!['none', LEGACY_REDACTION_VERSION].includes(String(envelope.redactionVersion)))
    throw new UploadError('redaction_version_mismatch', basename(path))
  if (envelope.recordBytes !== Buffer.byteLength(envelope.record))
    throw new UploadError('invalid_outbox', basename(path))
  if ('sha256' in envelope && digest(Buffer.from(envelope.record)) !== envelope.sha256)
    throw new UploadError('outbox_digest_mismatch', basename(path), true)
  return envelope as unknown as OutboxEnvelope
}
