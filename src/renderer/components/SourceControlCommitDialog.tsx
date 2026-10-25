import { useId, useRef } from 'react'
import type { ScRepository } from '@shared/source-control'
import { commitBlocker, commitFiles, isStaged } from '../source-control-workflow'
import { ModalFrame, requestModalClose } from './Modals'

export function SourceControlCommitDialog({ repo, selected, message, messageHead, onSelect, onMessage, onClose, onCommit }: {
  repo: ScRepository
  selected: string[]
  message: string
  messageHead: string | null
  onSelect: (path: string) => void
  onMessage: (message: string) => void
  onClose: () => void
  onCommit: () => void
}) {
  const id = useId()
  const messageInput = useRef<HTMLTextAreaElement>(null)
  const files = commitFiles(repo, selected)
  const blocker = commitBlocker(repo, selected)
  return (
    <ModalFrame labelledBy={id} initialFocusRef={messageInput} className="sc-commit-dialog" onClose={onClose}>
      <h2 id={id}>确认本次提交</h2>
      <p className="sc-muted">确认后才暂存所选工作区文件，再提交完整暂存区。不自动推送。</p>
      <div className="sc-commit-files" aria-label="确认提交范围">
        {repo.files.map((file) => (
          <label className="sc-commit-file" key={file.path}>
            <input type="checkbox" checked={isStaged(file) || selected.includes(file.path)}
              disabled={isStaged(file)} onChange={() => onSelect(file.path)}
              aria-label={`纳入本次提交 ${file.path}`} />
            <span><strong>{file.path}</strong><small>
              {isStaged(file) ? file.worktree !== '.' ? '仅现有暂存部分；未暂存余量保留' : '已有暂存内容，始终纳入本次提交' : '未勾选则留在工作区'}
            </small></span>
          </label>
        ))}
      </div>
      <label>提交说明
        <textarea ref={messageInput} value={message} maxLength={20_000} placeholder="这次改了什么，为什么改？"
          onChange={(event) => onMessage(event.target.value)} />
      </label>
      {message && messageHead !== repo.head && <p className="sc-notice">说明恢复自旧 HEAD，请重新核对提交范围。</p>}
      {blocker && <p className="sc-notice" role="alert">{blocker}</p>}
      <p className="sc-muted">目的地：本地 {repo.branch ?? 'Detached HEAD'}。已有暂存内容不会被重新整文件暂存。</p>
      <div className="sc-actions">
        <button onClick={() => requestModalClose()}>取消</button>
        <button className="sc-primary" disabled={!!blocker || !files.length || !message.trim()} onClick={onCommit}>
          确认提交 {files.length} 个文件
        </button>
      </div>
    </ModalFrame>
  )
}
