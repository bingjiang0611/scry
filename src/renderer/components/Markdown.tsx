import MarkdownImpl from './MarkdownImpl'

export function Markdown({ children }: { children: string }) {
  return <MarkdownImpl>{children}</MarkdownImpl>
}
