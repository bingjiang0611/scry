// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'





import { disclosureIsLong, useDisclosurePresence } from './Disclosure'

import Markdown from './MarkdownImpl'
import { Icon } from './primitives/Icon'
import type { TraceEvent } from '@shared/trace'





import { hookCancellationDetail } from '../format'
import type { Turn } from '../format'




const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function runtimeTitleForTurn(turn: Turn): { avatar: string; label: string } {
  const event = turn.items.find((item) => item.providerId || item.runtimeProvider)
  const raw = event?.providerId ?? event?.runtimeProvider?.replace(/_(sdk|cli|server)$/, '') ?? 'agent'
  const label = raw.charAt(0).toUpperCase() + raw.slice(1)
  return { avatar: label.charAt(0), label }
}

export function coalesceAdjacentThinking(items: readonly TraceEvent[]): TraceEvent[] {
  const out: TraceEvent[] = []
  for (const event of items) {
    const previous = out[out.length - 1]
    const sameStream =
      previous?.kind === 'model' && event.kind === 'model' &&
      previous.stage === 'thinking' && event.stage === 'thinking' &&
      previous.messageId === event.messageId &&
      previous.agentId === event.agentId &&
      previous.parentToolUseId === event.parentToolUseId
    if (sameStream) {
      out[out.length - 1] = {
        ...previous,
        thinking: `${previous.thinking ?? ''}${event.thinking ?? ''}`
      }
    } else {
      out.push(event)
    }
  }
  return out
}

export function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(true)
  const presence = useDisclosurePresence(open)
  const content = useRef<HTMLDivElement | null>(null)
  const [long, setLong] = useState(() => text.split('\n').length > 40)
  const measure = (): void => { if (content.current) setLong(disclosureIsLong(content.current)) }
  useBrowserLayoutEffect(measure, [open, presence.present])
  if (!text.trim()) return null
  return (
    <details className="thinking" open={open} data-long={long || undefined}
      onToggle={event => setOpen(event.currentTarget.open)}
      onTransitionEnd={event => { if (!open && event.nativeEvent.pseudoElement === '::details-content') presence.finishNow() }}>
      <summary className="think-head" aria-expanded={open} onClick={measure}>
        <Icon name="bulb" className="think-bulb" />
        <span>思考过程</span>
        <Icon name="chevronRight" className="think-chevron motion-chevron" />
      </summary>
      {presence.present && <div className="think-text md" aria-hidden={!open || undefined}
        ref={node => { content.current = node; presence.ref(node); if (node) node.inert = !open }}>
        <Markdown streaming={streaming}>{text}</Markdown>
      </div>}
    </details>
  )
}

export function fmtDur(ms?: number): string {
  if (ms == null) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function cancellationStatus(detail: NonNullable<ReturnType<typeof hookCancellationDetail>>): string {
  const label = detail.kind === 'timeout' ? '超时终止' : detail.kind === 'suspected-timeout' ? '疑似超时' : '已取消'
  if (detail.durationMs == null) return label
  const limit = detail.timeoutMs == null
    ? ''
    : ` / ${detail.timeoutSource === 'current-config' ? '当前配置上限' : '上限'} ${fmtDur(detail.timeoutMs)}`
  return `${label} · ${fmtDur(detail.durationMs)}${limit}`
}

export function hookCommandFromTrace(event: TraceEvent): string | undefined {
  if (event.hookCommand) return event.hookCommand
  const input = event.input as Record<string, unknown> | undefined
  return typeof input?.command === 'string' && input.command.trim() ? input.command.trim() : undefined
}

export function unsuccessfulHookStatus(event: TraceEvent): string {
  const cancellation = hookCancellationDetail(event)
  if (cancellation) return cancellationStatus(cancellation)
  const input = event.input as Record<string, unknown> | undefined
  const exitCode = event.hookExitCode ?? (typeof input?.exitCode === 'number' ? input.exitCode : undefined)
  return exitCode == null ? '执行失败' : `执行失败 · exit ${exitCode}`
}
