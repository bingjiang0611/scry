import type { ProviderId } from '@shared/provider'
import { PROVIDER_IDS } from './hooks/integration-model'

// renderer 崩溃后主进程会静默重载窗口，React 全量重挂会把 cwd / 选中会话清成 null。
// 这里记录"上次停在哪个项目的哪个会话"，重挂时据此回到原处；它只是恢复提示，
// 真伪仍由 pickSession 重新读取会话与运行证据来确认。
export interface StoredSessionSelection {
  cwd: string
  /** null 表示用户当时停在"新建会话"空态。 */
  sessionId: string | null
  /** legacy_unknown 不可再选择，因此不落盘。 */
  providerId: ProviderId
  externalSessionId?: string
  agentProfileId?: string
}

export const SESSION_SELECTION_STORAGE_KEY = 'scry.session-selection.v1'

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export function parseStoredSessionSelection(raw: string | null): StoredSessionSelection | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const cwd = optionalString(record.cwd)
  const providerId = PROVIDER_IDS.find((candidate) => candidate === record.providerId)
  if (!cwd || !providerId) return null
  return {
    cwd,
    sessionId: optionalString(record.sessionId) ?? null,
    providerId,
    externalSessionId: optionalString(record.externalSessionId),
    agentProfileId: optionalString(record.agentProfileId)
  }
}

export function readStoredSessionSelection(storage: StorageReader | undefined): StoredSessionSelection | null {
  try {
    return parseStoredSessionSelection(storage?.getItem(SESSION_SELECTION_STORAGE_KEY) ?? null)
  } catch {
    return null
  }
}

export function persistSessionSelection(
  selection: StoredSessionSelection | null,
  storage: StorageWriter | undefined
): void {
  try {
    if (!selection) storage?.removeItem(SESSION_SELECTION_STORAGE_KEY)
    else storage?.setItem(SESSION_SELECTION_STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // 存储不可用时只失去自动恢复能力，不阻断会话切换。
  }
}
