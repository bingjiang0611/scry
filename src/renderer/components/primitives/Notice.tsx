import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Icon } from './Icon'

export type NoticeTone = 'info' | 'warn' | 'bad'

type NoticeProps = ComponentPropsWithoutRef<'div'> & {
  /** info: neutral context; warn: needs attention but work can continue; bad: something failed. */
  tone?: NoticeTone
  /** box sits inside content; strip spans the full width of a panel edge. */
  layout?: 'box' | 'strip'
  /** sm for dense headers and inventory rows. */
  size?: 'sm' | 'md'
  /** At most one or two small buttons; the notice never owns navigation. */
  action?: ReactNode
}

/**
 * Inline notice. Tone is carried by icon, color and wording together so it is
 * never color-only. Callers choose `role` (status / alert) because only they
 * know whether the message is a live interruption; the primitive never adds
 * one implicitly.
 */
export function Notice({ tone = 'info', layout = 'box', size = 'md', action, className, children, ...props }: NoticeProps) {
  const classes = ['notice', tone, layout === 'strip' ? 'strip' : '', size === 'sm' ? 'sm' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div {...props} className={classes}>
      <Icon name={tone === 'info' ? 'info' : 'alert'} className="notice-icon" />
      <div className="notice-body">{children}</div>
      {action && <div className="notice-actions">{action}</div>}
    </div>
  )
}
