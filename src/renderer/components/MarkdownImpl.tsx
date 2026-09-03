import { createContext, memo, useContext, useDeferredValue, useMemo, type ReactNode } from 'react'
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
    <div className="md-table-scroll" role="region" aria-label="表格，可横向滚动" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  )
}

const MarkdownImpl = memo(function MarkdownImpl({ children }: { children: string }) {
  const deferredChildren = useDeferredValue(children)
  const normalizedChildren = normalizeMarkdownForDisplay(deferredChildren)
  const workspaceFileLink = useContext(WorkspaceFileLinkContext)
  const components = useMemo<Components>(() => ({
    ...baseComponents,
    code: ({ node: _node, children: codeChildren, className, ...props }) => {
      const reference = String(codeChildren)
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
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      urlTransform={(url, key) => key === 'src' ? (safeImageSrc(url) ?? '') : (safeExternalHref(url) ?? '')}
    >
      {normalizedChildren}
    </ReactMarkdown>
  )
})

export default MarkdownImpl
