import { useEffect, useRef, useState } from 'react'
import type { ConversationDeletionPreview } from '@shared/conversation-api'
import type { ConversationDeletionResult } from '@shared/conversation'
import { ModalFrame, requestModalClose } from './Modals'

export function ConversationDeleteDialog({ id, onChanged, onClose }: {
  id: string
  onChanged: () => void
  onClose: (attempted: boolean) => void
}) {
  const [preview, setPreview] = useState<ConversationDeletionPreview>()
  const [result, setResult] = useState<ConversationDeletionResult>()
  const [error, setError] = useState<string>()
  const [working, setWorking] = useState(false)
  const pending = useRef(false)
  const attempted = useRef(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let cancelled = false
    void window.scry.conversations.previewDeletion(id).then(
      preview => { if (!cancelled) setPreview(preview) },
      error => { if (!cancelled) setError(String(error)) }
    )
    return () => { cancelled = true }
  }, [id])
  useEffect(() => {
    if (!working && (result || error)) cancel.current?.focus()
  }, [working, result, error])
  const close = (): void => { if (!pending.current) onClose(attempted.current) }
  const confirm = async (): Promise<void> => {
    if (!preview || pending.current) return
    pending.current = true
    attempted.current = true
    setWorking(true)
    setError(undefined)
    try {
      setResult(await window.scry.conversations.delete(id, preview.fingerprint))
      onChanged()
    } catch (error) {
      setError(`${String(error)}。结果不能假定为未删除，请关闭后刷新证据核对；不会自动重试。`)
      onChanged()
    } finally { pending.current = false; setWorking(false) }
  }
  return <ModalFrame className="unified-preview unified-delete" labelledBy="conversation-delete-title" initialFocusRef={cancel} closeDisabled={working} onClose={close}>
    <h2 id="conversation-delete-title">{preview?.reclaim ? '重新核对并回收保留副本' : '删除统一对话的 Scry 副本'}</h2>
    <p>清理独占的归档、附件、用量、数据库记录及冻结的交接正文。已开始的删除不能恢复；部分失败保留入口供重新预览和继续清理。</p>
    <p>保留工作区文件和 .scry、Provider 原生历史、未发送草稿及最小归属记录。不会调用 Provider；只要存在共享引用，本次保留整组原生副本，不做逐轮回收。</p>
    {preview && <details open={!result}><summary>范围 · {preview.targets.length} 个原生或归档标识</summary><ul>
      {preview.targets.map(target => <li key={`${target.providerId}:${target.agentProfileId ?? ''}:${target.externalSessionId}`}>
        {target.providerId} · {target.externalSessionId} · {target.sharedWith.length ? `保留：仍被 ${target.sharedWith.join(', ')} 引用` : '清理独占副本'}
      </li>)}
    </ul></details>}
    {preview?.targets.some(target => target.sharedWith.length > 0) && <p role="note">本次仍被引用的整组副本会继续保留。引用消失后，可在已存档对话中重新预览并明确确认回收；不会自动清理。</p>}
    {!preview && !error && <p role="status">正在核对全部绑定、尝试和共享引用…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <section role="status"><b>{result.ok ? '逻辑入口已删除；下列记录按合同保留' : '未完整删除；关闭后可重新预览剩余范围'}</b>
      <ul>{result.retained.map(item => <li key={item}>{item}</li>)}</ul>
      {result.failed.map((failure, index) => <p key={index}>{failure.store}: {failure.error}</p>)}
    </section>}
    <div className="unified-actions">
      <button ref={cancel} className="btn" disabled={working} onClick={() => requestModalClose()}>{result ? '关闭' : '取消'}</button>
      {!result && <button className="btn danger" disabled={working || !preview || Boolean(error)} onClick={() => { void confirm() }}>{working ? '正在清理…' : preview?.reclaim ? '确认回收已无引用的副本' : '确认删除 Scry 副本'}</button>}
    </div>
  </ModalFrame>
}
