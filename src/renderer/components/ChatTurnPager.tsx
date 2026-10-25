// 对话流里「一轮」的渲染（蓝本 chat.html）：用户气泡 / who(头像+runid) / 思考 / 工具卡 / 本轮文件 / turn-footer。
import { useCallback, useEffect, useRef, useState } from 'react'










import type { ContentRef, RecorderContentPage } from '@shared/tool-content'











const CONTENT_PAGE_BYTES = 64 * 1024
const CONTENT_PAGE_CACHE = 8

type DisplayContentPage = RecorderContentPage & { text: string }

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function RecorderContentPager({ label, contentRef, source, remote = false }: { label: string; contentRef: ContentRef; source?: string; remote?: boolean }) {
  const [pages, setPages] = useState<DisplayContentPage[]>([])
  const [cursor, setCursor] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const decoderRef = useRef(new TextDecoder())
  const generationRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    setPages([])
    setCursor(-1)
    setLoading(false)
    setError(undefined)
    decoderRef.current = new TextDecoder()
  }, [contentRef.sha256, source])

  const load = useCallback(async (offset: number) => {
    const generation = generationRef.current
    setLoading(true)
    setError(undefined)
    try {
      const page = await window.scry.recorderContentPage({ ref: contentRef, offset, limit: CONTENT_PAGE_BYTES,
        ...(source === 'scry_app_trace' ? { source: 'app-trace' as const } : {}) })
      if (generation !== generationRef.current) return
      const text = decoderRef.current.decode(bytesFromBase64(page.dataBase64), { stream: page.hasMore })
      setPages((current) => {
        const next = [...current, { ...page, text }].slice(-CONTENT_PAGE_CACHE)
        setCursor(next.length - 1)
        return next
      })
    } catch (reason) {
      if (generation === generationRef.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [contentRef, source])

  const page = pages[cursor]
  if (remote) return <div className="recorder-content-page" role="note">远程正文引用不可在本机读取。</div>
  return (
    <div className="recorder-content-page">
      {!page ? (
        <button type="button" onClick={() => void load(0)} disabled={loading}>
          {loading ? '正在读取…' : `查看完整 ${label} · ${contentRef.bytes.toLocaleString()} bytes`}
        </button>
      ) : (
        <>
          <div className="lbl">完整 {label} · bytes {page.offset}–{page.nextOffset} / {page.totalBytes}</div>
          <pre>{page.text}</pre>
          <div className="recorder-content-page-actions">
            <button type="button" disabled={cursor <= 0 || loading} onClick={() => setCursor((value) => value - 1)}>上一页</button>
            <button
              type="button"
              disabled={loading || (cursor >= pages.length - 1 && !page.hasMore)}
              onClick={() => {
                if (cursor < pages.length - 1) setCursor((value) => value + 1)
                else void load(page.nextOffset)
              }}
            >{loading ? '正在读取…' : '下一页'}</button>
          </div>
        </>
      )}
      {error && <div role="alert">完整正文读取失败：{error}</div>}
    </div>
  )
}

// 蓝本 .tool-card：状态(check/x) · 工具名 · op(R/W/E) · arg · meta(dur/tok/danger) · chev；点开内联展开 tool-detail。
