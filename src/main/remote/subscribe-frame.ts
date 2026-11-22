import { DESKTOP_HISTORY_CHUNK_BYTES, DESKTOP_HISTORY_MAX_BYTES } from '../../shared/desktop-remote'
import { SUBSCRIBE_VIEWS, type SubscribeRequest, type SubscribeView } from '../../shared/orchestration-subscribe'

const BODY_KEYS = ['op', 'views', 'session', 'known', 'sessionsCursor', 'waitMs', 'eventSet', 'chunk']
const TRANSPORT_KEYS = ['keepAlive', 'protocol', 'deviceLabel']

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
}

/** Shared by the network endpoint and execution target forwarding. */
export function parseSubscribeFrame(
  request: Record<string, unknown>,
  transport: 'local' | 'network' | 'target'
): SubscribeRequest | undefined {
  const keys = transport === 'target' ? BODY_KEYS
    : [...BODY_KEYS, ...TRANSPORT_KEYS, ...(transport === 'local' ? ['detailWatch'] : [])]
  if (Object.keys(request).some((key) => !keys.includes(key))) return undefined
  const network = transport !== 'local'
  const { views, session, known, sessionsCursor, detailWatch, waitMs, eventSet, chunk } = request
  if (!Array.isArray(views) || views.length === 0 || views.length > 3 ||
      !views.every((v): v is SubscribeView => typeof v === 'string' && SUBSCRIBE_VIEWS.has(v as SubscribeView))) {
    return undefined
  }
  if (!Number.isSafeInteger(waitMs) || (waitMs as number) < 0 || (network && (waitMs as number) > 25_000)) return undefined
  if (eventSet !== undefined && (!Number.isSafeInteger(eventSet) || (eventSet as number) < 1)) return undefined
  if (sessionsCursor !== undefined && (typeof sessionsCursor !== 'string' || sessionsCursor.length === 0 || sessionsCursor.length > 512)) {
    return undefined
  }
  let parsedSession: SubscribeRequest['session']
  if (session !== undefined) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return undefined
    const s = session as Record<string, unknown>
    if (!text(s.sessionKey, 4096)) return undefined
    if (network && (Object.hasOwn(s, 'providerId') && !text(s.providerId, 64) ||
        Object.hasOwn(s, 'agentProfileId') && !text(s.agentProfileId, 128) ||
        Object.hasOwn(s, 'cwd') && !text(s.cwd, 16_384) ||
        Object.hasOwn(s, 'externalSessionId') && !text(s.externalSessionId, 256))) return undefined
    parsedSession = {
      sessionKey: s.sessionKey,
      ...(typeof s.providerId === 'string' ? { providerId: s.providerId } : {}),
      ...(typeof s.agentProfileId === 'string' ? { agentProfileId: s.agentProfileId } : {}),
      ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
      ...(typeof s.externalSessionId === 'string' ? { externalSessionId: s.externalSessionId } : {})
    }
  }
  if (views.includes('detail') && !parsedSession) return undefined
  if (network && new Set(views).size !== views.length) return undefined
  if (network && sessionsCursor !== undefined && !views.includes('sessions')) return undefined
  if (network && (detailWatch !== undefined || (views.includes('detail') && views.length !== 1))) return undefined
  if (detailWatch !== undefined && (!views.includes('detail') || chunk !== undefined ||
      (detailWatch !== 'open' && detailWatch !== 'continue'))) return undefined
  let parsedChunk: SubscribeRequest['chunk']
  if (chunk !== undefined) {
    if (!views.includes('detail') || !chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return undefined
    const { id, offset } = chunk as Record<string, unknown>
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id) || typeof offset !== 'number' ||
        offset <= 0 || offset >= DESKTOP_HISTORY_MAX_BYTES || offset % DESKTOP_HISTORY_CHUNK_BYTES !== 0) {
      return undefined
    }
    parsedChunk = { id, offset }
  }
  let parsedKnown: SubscribeRequest['known']
  if (known !== undefined) {
    if (!known || typeof known !== 'object' || Array.isArray(known)) return undefined
    const k = known as Record<string, unknown>
    if (typeof k.hostId !== 'string' || k.hostId.length === 0 || k.hostId.length > 128 ||
        typeof k.logId !== 'string' || k.logId.length === 0 || k.logId.length > 128 ||
        !Number.isSafeInteger(k.seq) || (k.seq as number) < 0) {
      return undefined
    }
    parsedKnown = { hostId: k.hostId, logId: k.logId, seq: k.seq as number }
  }
  return {
    views,
    waitMs: waitMs as number,
    ...(parsedSession ? { session: parsedSession } : {}),
    ...(parsedKnown ? { known: parsedKnown } : {}),
    ...(parsedChunk ? { chunk: parsedChunk } : {}),
    ...(detailWatch ? { detailWatch } : {}),
    ...(sessionsCursor !== undefined ? { sessionsCursor: sessionsCursor as string } : {}),
    ...(eventSet !== undefined ? { eventSet: eventSet as number } : {})
  }
}
