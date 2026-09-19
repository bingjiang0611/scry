import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { canOpenWorkspaceFileExternally } from '@shared/workspace'
import { resolveWorkspaceFileTarget, type WorkspaceFileTarget } from '../workspace-links'
import { Icon } from './primitives/Icon'

function safeExternalHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const protocol = new URL(href).protocol
    return protocol === 'https:' || protocol === 'http:' ? href : undefined
  } catch {
    return href.startsWith('#') ? href : undefined
  }
}

function safeImageSrc(src: string | undefined): string | undefined {
  return src?.startsWith('data:image/') || src?.startsWith('blob:') ? src : undefined
}

function linkedCodeText(node: unknown): string | null {
  const children = (node as { children?: unknown[] } | undefined)?.children
  if (children?.length !== 1) return null
  const code = children[0] as { type?: string; tagName?: string; children?: unknown[] }
  if (code.type !== 'element' || code.tagName !== 'code') return null
  const text = code.children?.[0] as { type?: string; value?: unknown } | undefined
  return code.children?.length === 1 && text?.type === 'text' && typeof text.value === 'string' ? text.value : null
}

function normalizeStrongSpacing(segment: string): string {
  return segment.replace(
    /(^|[^\\*])\*\*([ \t]*)([^*\n]*?\S)([ \t]*)\*\*/g,
    (match, prefix: string, _leading: string, content: string, trailing: string, offset: number, source: string) => {
      const next = source[offset + match.length]
      const contentEnd = content.at(-1) ?? ''
      const needsSeparator = !!trailing || (
        !!next && /[\p{L}\p{N}]/u.test(next) && /[\p{P}\p{S}]/u.test(contentEnd)
      )
      return `${prefix}**${content}**${needsSeparator ? ' ' : ''}`
    }
  )
}

function normalizeOutsideInlineCode(line: string): string {
  let cursor = 0
  let normalized = ''
  while (cursor < line.length) {
    const start = line.indexOf('`', cursor)
    if (start < 0) return normalized + normalizeStrongSpacing(line.slice(cursor))
    let runLength = 1
    while (line[start + runLength] === '`') runLength += 1
    const delimiter = '`'.repeat(runLength)
    const end = line.indexOf(delimiter, start + runLength)
    if (end < 0) return normalized + normalizeStrongSpacing(line.slice(cursor))
    normalized += normalizeStrongSpacing(line.slice(cursor, start))
    normalized += line.slice(start, end + runLength)
    cursor = end + runLength
  }
  return normalized
}

export function normalizeMarkdownForDisplay(source: string): string {
  let fence: { marker: string; length: number } | null = null
  return source.split('\n').map((line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length) fence = null
      return line
    }
    if (match) {
      fence = { marker: match[1][0], length: match[1].length }
      return line
    }
    return normalizeOutsideInlineCode(line)
  }).join('\n')
}

interface WorkspaceFileLinkContextValue {
  workspaces: readonly string[]
  onOpen: (target: WorkspaceFileTarget) => void
}

const WorkspaceFileLinkContext = createContext<WorkspaceFileLinkContextValue | null>(null)

export function WorkspaceFileLinkProvider({
  workspaces,
  onOpen,
  children
}: {
  workspaces: readonly string[]
  onOpen?: (target: WorkspaceFileTarget) => void
  children: ReactNode
}) {
  const value = useMemo<WorkspaceFileLinkContextValue | null>(
    () => workspaces.length > 0 && onOpen ? { workspaces, onOpen } : null,
    [onOpen, workspaces]
  )
  return <WorkspaceFileLinkContext.Provider value={value}>{children}</WorkspaceFileLinkContext.Provider>
}

const baseComponents: Components = {
  a: ({ node, href, children, ...props }) => {
    const safe = safeExternalHref(href)
    const codeText = linkedCodeText(node)
    const content = codeText == null ? children : <code>{codeText}</code>
    if (!safe) return <span>{content}</span>
    const external = safe.startsWith('http://') || safe.startsWith('https://')
    return <a {...props} href={safe} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{content}</a>
  },
  img: ({ src, alt }) => {
    // 只放行内联 data:/blob: 图片（远程图片仍然阻断）；懒加载 + 异步解码避免长会话里
    // 一次性解码所有历史图片阻塞主线程。
    const safe = safeImageSrc(typeof src === 'string' ? src : undefined)
    return safe
      ? <img src={safe} alt={alt ?? ''} loading="lazy" decoding="async" />
      : <span role="img" aria-label={alt ? `已阻止远程图片：${alt}` : '已阻止远程图片'}>[远程图片已阻止]</span>
  },
  table: ({ node: _node, children, ...props }) => (
    <div className="md-table-scroll" role="region" aria-label="表格，可横向和纵向滚动" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  )
}

const remarkPlugins = [remarkGfm]
export const STREAMING_MARKDOWN_LIGHTWEIGHT_THRESHOLD = 48_000
const PROGRESSIVE_MARKDOWN_CHUNK_TARGET = 8_000

export function streamingMarkdownInterval(sourceLength: number): number {
  // 人眼无法从逐帧 Markdown 重排中获益；把短回复限制在约 12fps，长回复继续降频，
  // 为输入、滚动和停止按钮保留 renderer 主线程时间。
  if (sourceLength <= 12_000) return 80
  if (sourceLength <= STREAMING_MARKDOWN_LIGHTWEIGHT_THRESHOLD) return 120
  return 200
}

export function shouldUseLightweightStreamingMarkdown(sourceLength: number, streaming: boolean): boolean {
  return streaming && sourceLength > STREAMING_MARKDOWN_LIGHTWEIGHT_THRESHOLD
}

/**
 * Split only at ATX headings outside fenced code. Reference definitions and footnotes may resolve
 * across the whole document, so those sources deliberately keep the single authoritative parse.
 */
export function splitMarkdownForProgressiveRender(source: string): string[] {
  if (source.length <= STREAMING_MARKDOWN_LIGHTWEIGHT_THRESHOLD) return [source]
  if (/^\s*\[[^\]]+\]:\s+/m.test(source) || /\[\^[^\]]+\]/.test(source)) return [source]
  const lines = source.split('\n')
  const sections: string[] = []
  let current: string[] = []
  let fence: { marker: string; length: number } | null = null
  const flush = (): void => {
    if (current.length === 0) return
    sections.push(current.join('\n'))
    current = []
  }
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker[0] === fence.marker && marker.length >= fence.length) fence = null
      continue
    }
    if (marker) {
      fence = { marker: marker[0], length: marker.length }
      current.push(line)
      continue
    }
    if (/^#{1,4}\s+\S/.test(line) && current.length > 0) flush()
    current.push(line)
  }
  flush()
  if (sections.length < 2) return [source]
  const chunks: string[] = []
  let pending = ''
  for (const section of sections) {
    const joined = pending ? `${pending}\n${section}` : section
    if (pending && joined.length > PROGRESSIVE_MARKDOWN_CHUNK_TARGET) {
      chunks.push(pending)
      pending = section
    } else pending = joined
  }
  if (pending) chunks.push(pending)
  return chunks.length > 1 ? chunks : [source]
}

function useSampledMarkdownSource(source: string, streaming: boolean): string {
  const latest = useRef(source)
  latest.current = source
  const timer = useRef<number | null>(null)
  const sampledAt = useRef(0)
  const [sampled, setSampled] = useState(source)
  useEffect(() => {
    if (!streaming || !source.startsWith(sampled)) {
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = null
      sampledAt.current = performance.now()
      setSampled(source)
      return
    }
    if (sampled === source) return
    const interval = streamingMarkdownInterval(source.length)
    const remaining = interval - (performance.now() - sampledAt.current)
    if (remaining <= 0) {
      sampledAt.current = performance.now()
      setSampled(source)
    } else if (timer.current == null) {
      timer.current = window.setTimeout(() => {
        timer.current = null
        sampledAt.current = performance.now()
        setSampled(latest.current)
      }, remaining)
    }
  }, [sampled, source, streaming])
  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current)
  }, [])
  return !streaming || !source.startsWith(sampled) ? source : sampled
}

const MarkdownChunk = memo(function MarkdownChunk({
  source,
  components
}: {
  source: string
  components: Components
}) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={components}
      urlTransform={(url, key) => key === 'src' ? (safeImageSrc(url) ?? '') : (safeExternalHref(url) ?? '')}
    >
      {source}
    </ReactMarkdown>
  )
})

function useProgressiveChunkCount(chunks: readonly string[]): number {
  const [count, setCount] = useState(1)
  useEffect(() => {
    setCount(1)
    if (chunks.length <= 1) return
    let frame = 0
    const advance = (): void => {
      setCount((current) => {
        if (current >= chunks.length) return current
        frame = window.requestAnimationFrame(advance)
        return current + 1
      })
    }
    frame = window.requestAnimationFrame(advance)
    return () => window.cancelAnimationFrame(frame)
  }, [chunks])
  return Math.min(count, chunks.length)
}

const MarkdownImpl = memo(function MarkdownImpl({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const sampledChildren = useSampledMarkdownSource(children, streaming)
  const lightweight = shouldUseLightweightStreamingMarkdown(sampledChildren.length, streaming)
  const normalizedChildren = lightweight ? sampledChildren : normalizeMarkdownForDisplay(sampledChildren)
  const progressiveChunks = useMemo(
    () => !streaming ? splitMarkdownForProgressiveRender(normalizedChildren) : [normalizedChildren],
    [normalizedChildren, streaming]
  )
  const progressiveCount = useProgressiveChunkCount(progressiveChunks)
  const workspaceFileLink = useContext(WorkspaceFileLinkContext)
  const components = useMemo<Components>(() => ({
    ...baseComponents,
    code: ({ node: _node, children: codeChildren, className, ...props }) => {
      const reference = String(codeChildren)
      const externalHref = safeExternalHref(reference)
      if (externalHref && /^https?:\/\//i.test(externalHref)) {
        return (
          <a href={externalHref} target="_blank" rel="noopener noreferrer">
            <code {...props} className={className}>{codeChildren}</code>
          </a>
        )
      }
      const target = workspaceFileLink && !reference.includes('\n')
        ? resolveWorkspaceFileTarget(workspaceFileLink.workspaces, reference)
        : null
      if (!target) return <code {...props} className={className}>{codeChildren}</code>

      const external = canOpenWorkspaceFileExternally(target.path)
      const open = workspaceFileLink?.onOpen
      const title = external ? `${target.path} · 在外部应用打开` : `${target.path} · 在右侧文件面板打开`
      return (
        <button
          type="button"
          className="md-file-ref"
          title={title}
          aria-label={title}
          onClick={() => open?.(target)}
        >
          <Icon name="file" className="md-file-ref-icon" />
          <code {...props} className={className}>{codeChildren}</code>
        </button>
      )
    }
  }), [workspaceFileLink])
  if (lightweight) {
    // Parsing an ever-growing large GFM document can monopolize the renderer for hundreds of
    // milliseconds per sample. Preserve every character in a cheap, selectable live view.
    return <pre className="md-streaming-plain" aria-label="大型回复流式文本">{sampledChildren}</pre>
  }
  if (progressiveChunks.length > 1) {
    const remaining = progressiveChunks.slice(progressiveCount).join('\n')
    return (
      <>
        {progressiveChunks.slice(0, progressiveCount).map((source, index) => (
          <MarkdownChunk key={`${index}:${source.length}`} source={source} components={components} />
        ))}
        {remaining ? <pre className="md-streaming-plain" aria-label="等待格式化的完整文本">{remaining}</pre> : null}
      </>
    )
  }
  return <MarkdownChunk source={normalizedChildren} components={components} />
})

export default MarkdownImpl
