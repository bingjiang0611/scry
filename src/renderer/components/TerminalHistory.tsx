import { useEffect, useId, useMemo, useState } from 'react'
import type { TerminalRecordingListPage, TerminalRecordingSummary } from '@shared/terminal'
import { defaultTerminalApi, type TerminalApi } from '../workbench-api'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'

export function terminalRecordingLabel(item: TerminalRecordingSummary): string {
  if (item.active) return item.state === 'failed' ? 'Shell 运行中 · 录制失败' : 'Shell 运行中'
  if (item.state === 'complete') return '录制已结束'
  if (item.state === 'failed') return '录制失败 · 仅已存前缀'
  return '终态未确认 · 仅已存前缀'
}

export function TerminalHistory({ cwd, canOpen, onOpen, onClose, api: injectedApi }: {
  cwd: string | null
  canOpen: boolean
  onOpen: (item: TerminalRecordingSummary) => void
  onClose: () => void
  api?: TerminalApi
}) {
  const titleId = useId()
  const api = useMemo(() => injectedApi ?? defaultTerminalApi, [injectedApi])
  const [after, setAfter] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<TerminalRecordingListPage | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setBusy(true)
    setPage(null)
    setError(null)
    void api.terminalRecordingList({ after, limit: 20 }).then((value) => {
      if (current) setPage(value)
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [after, api, revision])
  return (
    <ModalFrame labelledBy={titleId} onClose={onClose}>
      <header className="modal-head">
        <h2 id={titleId}>终端录制历史</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭录制历史"><Icon name="x" /></button>
      </header>
      <div className="modal-body">
        <p title={cwd ?? '用户主目录'}>当前工作区：{cwd ?? '用户主目录'} · 原文可能含密钥</p>
        {busy && <p role="status">正在读取录制索引…</p>}
        {error && <p role="alert">录制列表不可用：{error}</p>}
        {page?.partial && <p role="alert">部分索引不可读，列表可能不完整；未展示其标识或内容。</p>}
        {!canOpen && <p role="status">终端标签页已达上限，请先关闭一个标签页。</p>}
        {page && page.items.length === 0 && <p>本页没有可列出的录制。</p>}
        <div className="arch-list">
          {page?.items.map((item) => (
            <div className="arch-row" key={item.id} data-recording-id={item.id}>
              <div className="arch-row-copy">
                <b title={item.id}>录制 {item.id.slice(9, 17)}</b>
                <div className="arch-row-meta">
                  <span>{terminalRecordingLabel(item)}</span>
                  <span>{item.bytes.toLocaleString()} B 已存索引</span>
                  <span>{item.startedAt === undefined ? '开始时间未知' : new Date(item.startedAt).toLocaleString()}</span>
                </div>
              </div>
              <button type="button" className="arch-unarch" disabled={busy || item.active || !canOpen} onClick={() => onOpen(item)} aria-label={`只读打开 ${item.id}`}>只读打开</button>
            </div>
          ))}
        </div>
      </div>
      <footer className="modal-foot">
        <span>按 ID 分页 · 回放时校验正文 · 不恢复 Shell</span>
        <button type="button" className="btn" disabled={busy} onClick={() => { setAfter(undefined); setRevision((value) => value + 1) }}>首页 / 刷新</button>
        <button type="button" className="btn" disabled={busy || !page?.nextCursor} onClick={() => setAfter(page?.nextCursor ?? undefined)}>下一页</button>
      </footer>
    </ModalFrame>
  )
}
