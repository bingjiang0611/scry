import { useEffect, useRef, useState } from 'react'
import type { ConversationAdoptionPreview, ConversationLegacySource, ConversationSummary } from '@shared/conversation-api'
import { ModalFrame, requestModalClose } from './Modals'

export function ConversationAdoptionDialog({ source, onAdopted, onClose }: {
  source: ConversationLegacySource
  onAdopted: (conversation: ConversationSummary) => void
  onClose: () => void
}) {
  const [preview, setPreview] = useState<ConversationAdoptionPreview>()
  const [error, setError] = useState<string>()
  const [working, setWorking] = useState(false)
  const pending = useRef(false)
  const sourceRef = useRef(source)
  useEffect(() => {
    let cancelled = false
    void window.scry.conversations.previewAdoption(sourceRef.current).then(
      value => { if (!cancelled) setPreview(value) },
      error => { if (!cancelled) setError(String(error)) }
    )
    return () => { cancelled = true }
  }, [])
  const close = (): void => { if (!pending.current) onClose() }
  const confirm = async (): Promise<void> => {
    if (!preview || pending.current) return
    pending.current = true
    setWorking(true)
    setError(undefined)
    try {
      const conversation = await window.scry.conversations.adopt(preview.source, preview.fingerprint)
      onAdopted(conversation)
    } catch (error) {
      setError(`${String(error)}。请刷新列表核对；再次确认只核对同一迁移指纹，不会调用 Provider。`)
    } finally { pending.current = false; setWorking(false) }
  }
  return <ModalFrame className="unified-preview unified-adoption" labelledBy="adoption-title" closeDisabled={working} onClose={close}>
    <h2 id="adoption-title">迁入已捕获历史</h2>
    <p>只迁入 Scry 已完整捕获的 App 归档，不代表 Provider 的全部原生历史。原始文件保留，不发送消息、不新增用量。</p>
    <p>旧捕获没有可证明的账号接续身份。旧绑定将保持只读；后续发送必须明确新建原生上下文，不会假装恢复旧上下文。</p>
    <p>提交成功后，旧侧边栏条目替换为同一工作区的统一对话；失败不会删除旧入口。</p>
    {preview ? <p>{preview.title} · {preview.turnCount} 轮 · {preview.source.providerId}</p> : !error && <p role="status">正在核对完整归档…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="unified-actions">
      <button className="btn" disabled={working} onClick={() => requestModalClose()}>取消</button>
      <button className="btn primary" disabled={working || !preview} onClick={() => { void confirm() }}>{working ? '正在迁入…' : '确认迁入，不发送'}</button>
    </div>
  </ModalFrame>
}
