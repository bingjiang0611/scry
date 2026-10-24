import { useRef } from 'react'
import type { RefObject } from 'react'
import type { ChatViewProps } from './types'
import { WorkdirPicker } from '../Pickers'
import { Icon } from '../primitives/Icon'
import { QUEUE_COPY } from '../../constants/copy'
import { RunElapsed } from './RunElapsed'
import { imageFilesFromClipboardData, composerEnterConfirmsIme, navigateComposerHistory } from './composer-utils'

type ComposerInputProps = Pick<ChatViewProps,
  'cwd'
  | 'recent'
  | 'onChooseFolder'
  | 'onUnbindProject'
  | 'onPickRecent'
  | 'onRemoveRecent'
  | 'renderLocationPicker'
  | 'composerNotice'
  | 'busy'
  | 'traceHealth'
  | 'onStop'
  | 'onCancelQueuedPromptEdit'
  | 'onInput'
  | 'onPasteImages'
  | 'onPasteClipboardImage'
  | 'onRemoveDraftAttachment'
  | 'onRetryDetection'
  | 'detectionRetrying'
  | 'onHideSlash'
  | 'onSlashSel'
  | 'onPickSlash'
> & {
  textareaRef: RefObject<HTMLTextAreaElement>
  composerMenu: 'workdir' | 'agent' | 'modelEffort' | null
  setComposerMenu: (menu: 'workdir' | 'agent' | 'modelEffort' | null) => void
  input: string
  draftAttachments: ChatViewProps['draftAttachments']
  sendBlockedReason: string | null
  composerError: string | null
  detectionIssue: string | null
  sessionLoading: boolean
  showWorkdirPicker: boolean
  stopStatus: ReturnType<typeof import('../../run-stop-status').runStopStatus>
  backgroundStatus?: ReturnType<typeof import('../../background-work-status').backgroundWorkStatus>
  runStartedAt: number
  editingQueuedIndex: number
  resetPromptHistory: () => void
  onSend: () => void
  slashOpen: boolean
  slashMatches: ReturnType<typeof import('./composer-utils').filterSlashCommands>
  slashSel: number
  slashLoading?: boolean
  slashCmds?: ChatViewProps['slashCmds']
  slashReason?: string | null
  promptHistory: string[]
  historyNavigation: { scopeKey?: string; history: string[]; position: number } | null
  promptHistoryRef: { current: { scopeKey?: string; history: string[]; position: number } | null }
  composerScopeKey?: string
}

export function ComposerInput({
  textareaRef,
  composerMenu,
  setComposerMenu,
  input,
  draftAttachments,
  cwd,
  recent,
  onChooseFolder,
  onUnbindProject = () => {},
  onPickRecent,
  onRemoveRecent,
  renderLocationPicker,
  composerNotice,
  busy,
  traceHealth,
  onStop,
  onCancelQueuedPromptEdit,
  onInput,
  onPasteImages,
  onPasteClipboardImage,
  onRemoveDraftAttachment,
  onRetryDetection,
  detectionRetrying,
  showWorkdirPicker,
  sendBlockedReason,
  composerError,
  detectionIssue,
  sessionLoading,
  stopStatus,
  backgroundStatus,
  runStartedAt,
  editingQueuedIndex,
  resetPromptHistory,
  onSend,
  slashOpen,
  slashMatches,
  slashSel,
  promptHistory,
  historyNavigation,
  promptHistoryRef,
  composerScopeKey,
  onHideSlash,
  onSlashSel,
  onPickSlash
}: ComposerInputProps) {
  const compositionActiveRef = useRef(false)
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const composerStatus = composerError ?? detectionIssue ?? (input.trim() || draftAttachments.length > 0 ? sendBlockedReason : null)
  return <>
        {draftAttachments.length > 0 && (
          <div className="draft-attachments" aria-label="已粘贴图片">
            {draftAttachments.map((attachment) => (
              <div className="draft-attachment" key={attachment.id} title={attachment.name}>
                <img src={attachment.previewUrl} alt="" loading="lazy" decoding="async" />
                <span>{attachment.name}</span>
                <button type="button" onClick={() => onRemoveDraftAttachment(attachment.id)} title="移除图片">
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </div>
        )}
        {showWorkdirPicker && <div className="composer-context" role="group" aria-label="会话上下文">
          {renderLocationPicker ? renderLocationPicker({
            open: composerMenu === 'workdir',
            onOpenChange: (open) => setComposerMenu(open ? 'workdir' : null)
          }) : (
            <WorkdirPicker
              cwd={cwd}
              recent={recent}
              onChoose={onChooseFolder}
              onUnbind={onUnbindProject}
              onPick={onPickRecent}
              onRemove={onRemoveRecent}
              open={composerMenu === 'workdir'}
              onOpenChange={(open) => setComposerMenu(open ? 'workdir' : null)}
            />
          )}
        </div>}
        {composerNotice && (
          <div className={`composer-notice is-${composerNotice.tone}`} role={composerNotice.tone === 'error' ? 'alert' : 'status'}>
            <Icon name={composerNotice.tone === 'error' ? 'alert' : 'info'} />
            <span title={composerNotice.text}>{composerNotice.text}</span>
            {composerNotice.action && (
              <button type="button" onClick={composerNotice.action.onClick} disabled={composerNotice.action.disabled}>
                {composerNotice.action.label}
              </button>
            )}
          </div>
        )}
        {busy && (
          <div className="run-status" role="status" aria-live="polite" data-stop-tone={stopStatus.tone} data-background-waiting={backgroundStatus?.waiting || undefined}>
            <span className="run-status-left">
              <i className="run-status-dot" aria-hidden="true" />
              <b>{backgroundStatus?.label ?? stopStatus.label}</b>
              <span className="run-status-hint">{backgroundStatus?.hint ?? stopStatus.hint}</span>
            </span>
            <span className="run-status-meta">
              {traceHealth?.degraded && (
                <span
                  className="run-status-trace-degraded"
                  title="实时视图为了保持界面可用而暂停镜像最新事件；本轮完整证据仍在 runState 与本机归档里，收口后会自动对齐"
                >
                  实时视图已降级 · 缺 {traceHealth.skippedEvents} 条
                </span>
              )}
              {!Number.isNaN(runStartedAt) && <RunElapsed startedAt={runStartedAt} />}
              <button type="button" className="stop run-status-stop" onClick={onStop} disabled={stopStatus.providerSettled}>
                <Icon name="square" /> 停止本轮
              </button>
            </span>
          </div>
        )}
        {editingQueuedIndex >= 0 && (
          <div className="composer-edit-hint" role="status">
            <Icon name="edit" />
            <span>{QUEUE_COPY.editingHint(editingQueuedIndex + 1)}</span>
            <button type="button" className="composer-edit-cancel" onClick={() => onCancelQueuedPromptEdit?.()}>
              {QUEUE_COPY.cancelEdit}
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="input"
          aria-label="描述任务"
          aria-describedby={composerStatus ? 'composer-status' : undefined}
          value={input}
          onChange={(event) => {
            resetPromptHistory()
            onInput(event.target.value)
          }}
          onCompositionStart={() => {
            compositionActiveRef.current = true
          }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false
            compositionEndedAtRef.current = performance.now()
          }}
          onKeyUp={() => {
            // The key that confirmed the IME candidate has been released (Enter,
            // Space, or a selection key). The next Enter is a new send intent,
            // not another confirmation merely because it arrived within 120 ms.
            compositionEndedAtRef.current = Number.NEGATIVE_INFINITY
          }}
          onPaste={(event) => {
            const files = imageFilesFromClipboardData(event.clipboardData)
            if (files.length > 0) {
              event.preventDefault()
              onPasteImages(files)
              return
            }
            if (!Array.from(event.clipboardData.types).includes('text/plain')) {
              event.preventDefault()
              onPasteClipboardImage()
            }
          }}
          onKeyDown={(event) => {
            const nativeCompositionActive = event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 || compositionActiveRef.current
            const imeEnter = event.key === 'Enter' && composerEnterConfirmsIme({
              nativeIsComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
              compositionActive: compositionActiveRef.current,
              compositionEndedAt: compositionEndedAtRef.current,
              now: performance.now()
            })
            if (slashOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                onSlashSel((index) => Math.min(index + 1, slashMatches.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                onSlashSel((index) => Math.max(index - 1, 0))
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                onHideSlash()
                return
              }
              if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                !event.shiftKey &&
                !nativeCompositionActive &&
                !imeEnter &&
                slashMatches[slashSel]
              ) {
                event.preventDefault()
                onPickSlash(slashMatches[slashSel])
                return
              }
            }
            if (
              (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
              !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
              !nativeCompositionActive
            ) {
              const history = historyNavigation?.history ?? promptHistory
              const navigation = navigateComposerHistory(
                history,
                input,
                historyNavigation?.position ?? null,
                event.key === 'ArrowUp' ? 'older' : 'newer'
              )
              if (navigation) {
                event.preventDefault()
                promptHistoryRef.current = navigation.position == null ? null
                  : { scopeKey: composerScopeKey, history, position: navigation.position }
                onInput(navigation.value)
                requestAnimationFrame(() => {
                  textareaRef.current?.setSelectionRange(navigation.value.length, navigation.value.length)
                })
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              // Ignoring an IME confirmation or held Enter must not insert a newline.
              event.preventDefault()
              if (imeEnter || event.repeat) return
              if (sessionLoading || sendBlockedReason) return
              resetPromptHistory()
              onSend()
              return
            }
            // Esc 退出编辑态，行与原文本原样保留。放在 slash 之后，保留先关菜单的旧行为。
            if (event.key === 'Escape' && editingQueuedIndex >= 0) {
              event.preventDefault()
              onCancelQueuedPromptEdit?.()
            }
          }}
        />
        {composerStatus && (
          <div
            id="composer-status"
            className={`composer-status ${composerError ? 'is-error' : 'is-blocked'}`}
            role={composerError ? 'alert' : 'status'}
          >
            <Icon name={composerError ? 'alert' : 'info'} />
            <span>{composerStatus}</span>
            {detectionIssue && onRetryDetection && (
              <button type="button" className="composer-retry-detection" onClick={onRetryDetection} disabled={detectionRetrying}>
                <Icon name="refresh" />{detectionRetrying ? '检测中…' : '重新检测'}
              </button>
            )}
          </div>
        )}
  </>
}
