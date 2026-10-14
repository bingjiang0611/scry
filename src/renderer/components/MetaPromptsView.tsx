import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  filterMetaPrompts,
  META_PROMPT_TITLE_LIMIT,
  readMetaPrompts,
  writeMetaPrompts,
  type MetaPrompt
} from '../meta-prompts'
import { ModalFrame } from './Modals'
import { Icon } from './primitives/Icon'
import './meta-prompts.css'

type LibraryState = { status: 'ready'; prompts: MetaPrompt[] } | { status: 'error'; error: string }
type Notice = { error: boolean; text: string }

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

function loadLibrary(): LibraryState {
  try {
    return { status: 'ready', prompts: readMetaPrompts(window.localStorage) }
  } catch (error) {
    return { status: 'error', error: errorMessage(error) }
  }
}

export function MetaPromptsView({ onBack, onInsert }: {
  onBack: () => void
  onInsert: (body: string) => void
}) {
  const [library, setLibrary] = useState<LibraryState>(loadLibrary)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ prompt: MetaPrompt | null } | null>(null)
  const [deleting, setDeleting] = useState<MetaPrompt | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const deleteTitleId = useId()
  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => {
    if (!notice || notice.error) return
    const timer = window.setTimeout(() => setNotice(null), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  const prompts = library.status === 'ready' ? library.prompts : []
  const visible = filterMetaPrompts(prompts, query)
  const selected = visible.find(prompt => prompt.id === selectedId) ?? visible[0]

  const persist = (next: MetaPrompt[]): boolean => {
    try {
      writeMetaPrompts(window.localStorage, next)
      setLibrary({ status: 'ready', prompts: next })
      setNotice(null)
      return true
    } catch (error) {
      setNotice({ error: true, text: `保存失败：${errorMessage(error)}。原提示词未被更改。` })
      return false
    }
  }
  const copy = async (prompt: MetaPrompt): Promise<void> => {
    try {
      await window.scry.copyText(prompt.body)
      setNotice({ error: false, text: `已复制「${prompt.title}」` })
    } catch (error) {
      setNotice({ error: true, text: `复制失败：${errorMessage(error)}。可以选择正文手动复制。` })
    }
  }
  const save = (title: string, body: string): void => {
    if (!editor || library.status !== 'ready') return
    const prompt: MetaPrompt = { id: editor.prompt?.id ?? crypto.randomUUID(), title, body }
    const next = editor.prompt
      ? prompts.map(item => item.id === prompt.id ? prompt : item)
      : [prompt, ...prompts]
    if (!persist(next)) return
    setQuery('')
    setSelectedId(prompt.id)
    setEditor(null)
    setNotice({ error: false, text: '提示词已保存' })
  }
  const remove = (): void => {
    if (!deleting || library.status !== 'ready') return
    if (!persist(prompts.filter(prompt => prompt.id !== deleting.id))) return
    setDeleting(null)
    setNotice({ error: false, text: '提示词已删除' })
  }

  return (
    <section className="meta-prompts-view" aria-label="Meta Prompts 提示词库">
      <header className="mp-header">
        <div><h1>Meta Prompts</h1><p>常用提示词，随取随用。</p></div>
        <div className="mp-actions">
          <button type="button" className="mp-button mp-back" onClick={onBack}>返回会话</button>
          <button type="button" className="mp-button" disabled={library.status !== 'ready'} onClick={() => { setNotice(null); setEditor({ prompt: null }) }}><Icon name="plus" /> 新建提示词</button>
        </div>
      </header>
      {library.status === 'error' ? (
        <div className="mp-load-error" role="alert">
          <Icon name="alert" /><h2>提示词库无法读取</h2><p>{library.error}</p>
          <p>为避免覆盖原数据，当前不能新建或编辑提示词。</p>
          <button type="button" className="mp-button" onClick={() => setLibrary(loadLibrary())}>重新读取</button>
        </div>
      ) : (
        <div className="mp-layout">
          <aside className="mp-list" aria-label="提示词列表">
            <label className="mp-search"><Icon name="search" /><input ref={searchRef} type="search" aria-label="搜索提示词" placeholder="搜索标题或正文…" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <div className="mp-list-count">{query.trim() ? `${visible.length} 条匹配` : `${prompts.length} 条提示词`}</div>
            <div className="mp-rows">
              {visible.map(prompt => (
                <div key={prompt.id} className={`mp-row${selected?.id === prompt.id ? ' selected' : ''}`}>
                  <button type="button" className="mp-row-select" aria-pressed={selected?.id === prompt.id} onClick={() => setSelectedId(prompt.id)}>
                    <strong>{prompt.title}</strong><span>{prompt.body.split('\n')[0]}</span>
                  </button>
                  <button type="button" className="mp-icon-button" aria-label={`复制：${prompt.title}`} title="复制提示词" onClick={() => { void copy(prompt) }}><Icon name="copy" /></button>
                </div>
              ))}
              {visible.length === 0 && (
                <div className="mp-empty"><Icon name={prompts.length === 0 ? 'terminal' : 'search'} /><strong>{prompts.length === 0 ? '还没有提示词' : '没有匹配的提示词'}</strong><p>{prompts.length === 0 ? '把第一条常用指令保存下来。' : '试试标题或正文中的关键词。'}</p></div>
              )}
            </div>
            <div className="mp-list-foot">个人提示词库 · 保存在本机</div>
          </aside>
          <article className="mp-detail" aria-label="提示词详情">
            {selected ? <>
              <header className="mp-detail-header"><h2>{selected.title}</h2><div className="mp-actions">
                <button type="button" className="mp-icon-button" aria-label="编辑提示词" title="编辑" onClick={() => { setNotice(null); setEditor({ prompt: selected }) }}><Icon name="edit" /></button>
                <button type="button" className="mp-icon-button" aria-label="删除提示词" title="删除" onClick={() => { setNotice(null); setDeleting(selected) }}><Icon name="trash" /></button>
              </div></header>
              <pre className="mp-body">{selected.body}</pre>
              <footer className="mp-detail-footer"><span>{Array.from(selected.body).length} 字 · 纯文本</span><div className="mp-actions">
                <button type="button" className="mp-button" onClick={() => onInsert(selected.body)}>放入当前会话</button>
                <button type="button" className="mp-button mp-primary" onClick={() => { void copy(selected) }}><Icon name="copy" /> 复制提示词</button>
              </div></footer>
            </> : <div className="mp-empty mp-detail-empty"><strong>{prompts.length === 0 ? '保存常用指令，下次直接使用' : '没有可预览的提示词'}</strong><p>{prompts.length === 0 ? '只需标题和正文，不必创建 Skill。' : '调整搜索后再选择一条。'}</p>{prompts.length === 0 && <button type="button" className="mp-button" onClick={() => setEditor({ prompt: null })}><Icon name="plus" /> 新建提示词</button>}</div>}
          </article>
        </div>
      )}
      {notice && !editor && !deleting && <p className={`mp-notice${notice.error ? ' error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      {editor && <PromptEditor prompt={editor.prompt} error={notice?.error ? notice.text : null} onSave={save} onClose={() => { setEditor(null); setNotice(null) }} />}
      {deleting && <ModalFrame labelledBy={deleteTitleId} className="mp-delete-modal" onClose={() => { setDeleting(null); setNotice(null) }}>
        <div className="modal-head"><b id={deleteTitleId}>删除这条提示词？</b><button type="button" className="modal-x" aria-label="取消删除" onClick={() => setDeleting(null)}><Icon name="x" /></button></div>
        <div className="mp-delete-content"><p>「{deleting.title}」将从本机提示词库移除，无法撤销。</p>{notice?.error && <p className="mp-form-error" role="alert">{notice.text}</p>}</div>
        <footer className="mp-modal-footer"><button type="button" className="mp-button" onClick={() => setDeleting(null)}>取消</button><button type="button" className="mp-button mp-danger" onClick={remove}>删除</button></footer>
      </ModalFrame>}
    </section>
  )
}

function PromptEditor({ prompt, error, onSave, onClose }: {
  prompt: MetaPrompt | null
  error: string | null
  onSave: (title: string, body: string) => void
  onClose: () => void
}) {
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(prompt?.title ?? '')
  const [body, setBody] = useState(prompt?.body ?? '')
  const [discarding, setDiscarding] = useState(false)
  const changed = title !== (prompt?.title ?? '') || body !== (prompt?.body ?? '')
  const close = (): void => { if (changed) setDiscarding(true); else onClose() }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    onSave(title.trim(), body)
  }
  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={inputRef} className="mp-editor-modal" onClose={close}>
      <form onSubmit={submit}>
        <div className="modal-head"><b id={titleId}>{prompt ? '编辑提示词' : '新建提示词'}</b><button type="button" className="modal-x" aria-label="关闭提示词编辑器" onClick={close}><Icon name="x" /></button></div>
        <div className="mp-editor-fields">
          <label>标题<input ref={inputRef} required maxLength={META_PROMPT_TITLE_LIMIT} value={title} placeholder="例如：先写方案，再开始实现" onChange={event => setTitle(event.target.value)} /></label>
          <label>提示词正文<textarea required value={body} placeholder="写下你希望重复使用的指令…" onChange={event => setBody(event.target.value)} /></label>
          <div className="mp-editor-meta"><span>纯文本 · 不执行工具</span><span>{Array.from(body).length} 字</span></div>
          {error && <p className="mp-form-error" role="alert">{error}</p>}
          {discarding && <div className="mp-discard" role="alert"><strong>放弃未保存的修改？</strong><p>放弃后，本次修改不会保存。</p><div className="mp-actions"><button type="button" className="mp-button" onClick={() => setDiscarding(false)}>继续编辑</button><button type="button" className="mp-button mp-danger" onClick={onClose}>放弃修改</button></div></div>}
        </div>
        {!discarding && <footer className="mp-modal-footer"><button type="button" className="mp-button" onClick={close}>取消</button><button type="submit" className="mp-button mp-primary" disabled={!title.trim() || !body.trim()}>保存提示词</button></footer>}
      </form>
    </ModalFrame>
  )
}
