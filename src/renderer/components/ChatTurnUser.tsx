// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { memo, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'




import { Disclosure } from './Disclosure'

import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'



import { type AgentInputAttachment, type AgentSteerEvidence } from '@shared/runtime'

import { IMAGE_PREVIEW_COPY } from '../constants/copy'
import { ModalFrame, requestModalClose } from './Modals'
import { parseUserMessage } from '../format'





const attachmentSrcCache = new WeakMap<AgentInputAttachment, string>()
export function attachmentSrc(attachment: AgentInputAttachment): string {
  const cached = attachmentSrcCache.get(attachment)
  if (cached != null) return cached
  const src = `data:${attachment.mimeType};base64,${attachment.dataBase64}`
  attachmentSrcCache.set(attachment, src)
  return src
}

export function SteerEvidenceMessage({ evidence }: { evidence: AgentSteerEvidence }) {
  const terminal = evidence.status !== 'pending'
  const label = evidence.status === 'accepted'
    ? 'Provider 已接收'
    : evidence.status === 'rejected'
      ? 'Provider 已拒绝'
      : evidence.status === 'unavailable'
        ? 'Steer 不可用'
        : evidence.status === 'unknown'
          ? '结果未知'
          : '提交中'
  return (
    <div className={`steer-evidence steer-${evidence.status}`} data-steer-message-id={evidence.messageId} role="note">
      <div className="steer-evidence-head">
        <Icon name={evidence.status === 'accepted' ? 'check' : evidence.status === 'pending' ? 'clock' : 'alert'} />
        <b>Steer · {label}</b>
        {terminal && <span>原生回执不代表模型已读取或遵循</span>}
      </div>
      <UserMessage text={evidence.prompt} attachments={evidence.attachments} />
      {evidence.message && <div className="steer-evidence-message">{evidence.message}</div>}
    </div>
  )
}

function ImageLightbox({ attachment, onClose }: { attachment: AgentInputAttachment; onClose: () => void }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [zoom, setZoom] = useState(1)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const [fit, setFit] = useState<{ width: number; height: number } | null>(null)
  // 像素尺寸只在图片真正解码后出现：attachment 元数据不保证带尺寸，缺证据就不显示数字。
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const stage = stageRef.current
    const image = imageRef.current
    if (!stage || !image) return
    const resize = (): void => {
      if (!image.naturalWidth || !image.naturalHeight) return
      const ratio = Math.min(1, stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight)
      setFit({ width: image.naturalWidth * ratio, height: image.naturalHeight * ratio })
      setNatural((prev) =>
        prev && prev.width === image.naturalWidth && prev.height === image.naturalHeight
          ? prev
          : { width: image.naturalWidth, height: image.naturalHeight }
      )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    image.addEventListener('load', resize)
    resize()
    return () => {
      observer.disconnect()
      image.removeEventListener('load', resize)
    }
  }, [])
  // Transcript turns are virtualized: fixed overlays must escape their clipping and
  // stacking contexts without coupling the lightbox lifetime to an offscreen turn.
  return createPortal(
    <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="image-lightbox" onClose={onClose}>
      <h2 id={titleId} className="visually-hidden">{attachment.name}</h2>
      <div className="image-lightbox-bar">
        <span className="image-lightbox-name" title={attachment.name}>{attachment.name}</span>
        {natural && (
          <span className="image-lightbox-dims">{IMAGE_PREVIEW_COPY.dimensions(natural.width, natural.height)}</span>
        )}
        <button ref={closeRef} type="button" className="image-lightbox-close" onClick={() => requestModalClose()} aria-label={IMAGE_PREVIEW_COPY.close}>
          <Icon name="x" />
        </button>
      </div>
      <div ref={stageRef} className="image-lightbox-stage" tabIndex={0} aria-label={IMAGE_PREVIEW_COPY.stage}>
        <img
          ref={imageRef}
          src={attachmentSrc(attachment)}
          alt={attachment.name}
          decoding="async"
          style={{ width: fit ? fit.width * zoom : undefined, height: fit ? fit.height * zoom : undefined, visibility: fit ? 'visible' : 'hidden' }}
        />
      </div>
      <div className="image-lightbox-zoom" role="group" aria-label={IMAGE_PREVIEW_COPY.zoomGroup}>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} disabled={zoom <= 0.5} aria-label={IMAGE_PREVIEW_COPY.zoomOut}>
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="image-lightbox-reset"
          onClick={() => setZoom(1)}
          aria-label={IMAGE_PREVIEW_COPY.resetZoom(Math.round(zoom * 100))}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={() => setZoom((value) => Math.min(2, value + 0.25))} disabled={zoom >= 2} aria-label={IMAGE_PREVIEW_COPY.zoomIn}>
          <Icon name="plus" />
        </button>
      </div>
    </ModalFrame>,
    document.body
  )
}

function UserMessageImpl({
  text,
  attachments = []
}: {
  text: string
  attachments?: AgentInputAttachment[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState<AgentInputAttachment | null>(null)
  const skillDetailId = useId()
  const { command, body, injectedSkill } = parseUserMessage(text)

  // skill 注入：不是用户发的，渲染成中性折叠注记（默认收起，点开看 SKILL.md）
  if (!text && attachments.length === 0) return null
  if (injectedSkill) {
    const lineCount = body.split('\n').length
    const long = lineCount > 40
    return (
      <div className="skillinject">
        <button type="button" className="si-head" aria-expanded={expanded} aria-controls={skillDetailId} onClick={() => setExpanded((v) => !v)}>
          <Icon name="box" /> 注入 skill 内容 · <b>{injectedSkill}</b> · {lineCount} 行{' '}
          <span className="dim">（claude code 自动注入，非用户输入）</span>
          <Icon name="chevronRight" className={`chev motion-chevron ${expanded ? 'is-open' : ''}`} />
        </button>
        <Disclosure open={expanded} long={long}>{() => (
          <div id={skillDetailId} className="md si-body"><Markdown>{body}</Markdown></div>
        )}</Disclosure>
      </div>
    )
  }

  // 普通用户输入 / 命令 → 蓝色右对齐气泡（命令走气泡内 .slash chip）
  const lines = body ? body.split('\n') : []
  const long = lines.length > 12 || body.length > 800
  const shown = long && !expanded ? lines.slice(0, 10).join('\n') : body
  return (
    <div className="turn-user">
      <div className="bubble-user">
        {command && (
          <div className="slash">
            <Icon name="box" /> {command}
          </div>
        )}
        {body && (
          <div className="md user-md">
            <Markdown>{shown}</Markdown>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="user-attachments" aria-label="发送的图片">
            {attachments.map((attachment, index) => (
              <button
                type="button"
                className="user-attachment"
                key={`${attachment.name}:${attachment.size}:${index}`}
                onClick={() => setPreview(attachment)}
                aria-label={`放大查看图片 ${attachment.name}`}
                aria-haspopup="dialog"
                aria-expanded={preview === attachment}
              >
                <img src={attachmentSrc(attachment)} alt="" loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        )}
        {long && (
          <button
            type="button"
            className="expandbtn"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? 'chevronUp' : 'chevronDown'} />
            <span>{expanded ? '收起' : '展开全部'}</span>
            {!expanded && <span className="expandmeta">{lines.length} 行</span>}
          </button>
        )}
      </div>
      {preview && <ImageLightbox attachment={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

/**
 * Provider adapters may deliver reasoning token-by-token. Keep one disclosure per
 * contiguous model stream, including old archived traces that predate reducer coalescing.
 */

export const UserMessage = memo(UserMessageImpl)
