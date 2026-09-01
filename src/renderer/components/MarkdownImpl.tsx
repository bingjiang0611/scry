import { memo, useDeferredValue } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

function normalizeStrongSpacing(segment: string): string {
  return segment.replace(
    /(^|[^\\*])\*\*([ \t]*)([^*\n]*?\S)([ \t]*)\*\*/g,
    (match, prefix: string, _leading: string, content: string, trailing: string, offset: number, source: string) => {
      const next = source[offset + match.length]
      const needsSeparator = !!trailing || (!!next && /[\p{L}\p{N}]/u.test(next))
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

const components: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const safe = safeExternalHref(href)
    if (!safe) return <span>{children}</span>
    const external = safe.startsWith('http://') || safe.startsWith('https://')
    return <a {...props} href={safe} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
  },
  img: ({ src, alt }) => {
    const safe = safeImageSrc(typeof src === 'string' ? src : undefined)
    return safe
      ? <img src={safe} alt={alt ?? ''} />
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
