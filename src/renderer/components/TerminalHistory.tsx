import { useId, useMemo, useState } from 'react'
import type { TerminalRecordingListPage, TerminalRecordingSummary } from '@shared/terminal'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { useStaleWhileRefresh } from '../hooks/useStaleWhileRefresh'
import { defaultTerminalApi, type TerminalApi } from '../workbench-api'
import { ModalFrame, requestModalClose } from './Modals'
import { Button } from './primitives/Button'
import { EmptyState } from './primitives/EmptyState'
import { TERMINAL_EMPTY_COPY as copy } from '../constants/copy'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { SkeletonRows } from './primitives/Skeleton'
import { TurningIcon } from './primitives/TurningIcon'

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
  // The cursor is the whole key: another page is another answer and starts empty;
  // refreshing the same page keeps its rows on screen until the new read lands.
  const list = useStaleWhileRefresh<TerminalRecordingListPage>(after ?? '', (cursor) =>
    api.terminalRecordingList({ after: cursor || undefined, limit: 20 }))
  const page = list.data ?? null
  const busy = list.status === 'loading' || list.status === 'refreshing'
  const error = list.error
  const showSkeleton = useDelayedFlag(list.status === 'loading')
  return (
    <ModalFrame labelledBy={titleId} className="terminal-history-modal" onClose={onClose}>
      <header className="modal-head">
        <h2 id={titleId}>终端录制历史</h2>
        <ModalCloseButton onClick={() => requestModalClose()} aria-label="关闭录制历史" />
      </header>
      <div className="modal-body">
        <p title={cwd ?? '用户主目录'}>当前工作区：{cwd ?? '用户主目录'} · 原文可能含密钥</p>
        {error && <EmptyState size="card" picture="alert" announcement="alert"
          title={page ? copy.recordingRefreshFailed : copy.recordingReadFailed}
          actions={[{ label: copy.refreshRecording, icon: 'refresh', busy, onClick: list.refresh }]} />}
        {page?.partial && <p role="alert">部分索引不可读，列表可能不完整；未展示其标识或内容。</p>}
        {!canOpen && <p role="status">终端标签页已达上限，请先关闭一个标签页。</p>}
        {page && !error && page.items.length === 0 && <EmptyState size="row" title={page.partial ? copy.recordingPartial : copy.recordingEmpty} />}
        <div className="arch-list" aria-busy={busy}>
          {list.status === 'loading' && showSkeleton && <SkeletonRows rows={5} meta rowHeight={60} label="正在读取录制索引…" />}
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
              <button type="button" className="arch-unarch" disabled={item.active || !canOpen} onClick={() => onOpen(item)} aria-label={`只读打开 ${item.id}`}>只读打开</button>
            </div>
          ))}
        </div>
      </div>
      <footer className="modal-foot">
        <span>按 ID 分页 · 回放时校验正文 · 不恢复 Shell</span>
        <Button aria-busy={list.status === 'refreshing'} onClick={() => { if (after === undefined) list.refresh(); else setAfter(undefined) }}>
          <TurningIcon busy={list.status === 'refreshing'} /> 首页 / 刷新
        </Button>
        <Button disabled={busy || !page?.nextCursor} onClick={() => setAfter(page?.nextCursor ?? undefined)}>下一页</Button>
      </footer>
    </ModalFrame>
  )
}
