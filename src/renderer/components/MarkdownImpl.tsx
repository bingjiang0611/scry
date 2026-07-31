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
  }
}

export default function MarkdownImpl({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      urlTransform={(url, key) => key === 'src' ? (safeImageSrc(url) ?? '') : (safeExternalHref(url) ?? '')}
    >
      {children}
    </ReactMarkdown>
  )
}
