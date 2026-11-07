import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, appendWorkspaceReference, pathContains, WorkspacePanel, workspaceReferenceToken, resolveWorkspaceOps } = shared

describe('工作区文件面板', () => {
  it('提供文件树入口、筛选与可恢复删除语义', () => {
    const html = renderToStaticMarkup(
      <WorkspacePanel cwd="/tmp/project" onClose={() => {}} onAddReference={() => {}} />
    )

    expect(html).toContain('aria-label="工作区文件"')
    expect(html).toContain('筛选已展开的文件')
    expect(html).toContain('新建文件')
    expect(html).toContain('刷新文件树')
  })

  it('文件与目录引用转成可见 token，并避免重复插入', () => {
    expect(workspaceReferenceToken({ kind: 'file', path: 'src/App.tsx' })).toBe('@src/App.tsx')
    expect(workspaceReferenceToken({ kind: 'directory', path: 'docs/design notes' })).toBe('@"docs/design notes/"')
    expect(appendWorkspaceReference('检查', '@src/App.tsx')).toBe('检查 @src/App.tsx ')
    expect(appendWorkspaceReference('检查 @src/App.tsx ', '@src/App.tsx')).toBe('检查 @src/App.tsx ')
    expect(appendWorkspaceReference('检查 @"docs/design notes/" ', '@"docs/design notes/"')).toBe(
      '检查 @"docs/design notes/" '
    )
    expect(pathContains('src', 'src/App.tsx')).toBe(true)
    expect(pathContains('src', 'src-old/App.tsx')).toBe(false)
  })
})

describe('工作区能力来自宿主的 catalog', () => {
  it('宿主没报能力时保持原行为，不隐藏任何动作', () => {
    expect(resolveWorkspaceOps(undefined)).toEqual({ openPath: true, trashItem: true, notice: null })
  })

  it('宿主明确说不支持的动作被隐藏，并给出原因', () => {
    expect(resolveWorkspaceOps({ openPath: false, trashItem: false })).toEqual({
      openPath: false,
      trashItem: false,
      notice: '此工作区不支持：在系统应用中打开、移入废纸篓'
    })
    // Only the reported gap is named; the rest stays usable.
    expect(resolveWorkspaceOps({ openPath: true, trashItem: false }).notice).toBe('此工作区不支持：移入废纸篓')
  })

  it('面板按宿主能力隐藏删除入口并显示原因', () => {
    const restricted = renderToStaticMarkup(
      <WorkspacePanel cwd="/tmp/project" onClose={() => {}} onAddReference={() => {}} ops={{ openPath: false, trashItem: false }} />
    )
    expect(restricted).toContain('此工作区不支持：在系统应用中打开、移入废纸篓')
    const open = renderToStaticMarkup(
      <WorkspacePanel cwd="/tmp/project" onClose={() => {}} onAddReference={() => {}} ops={{ openPath: true, trashItem: true }} />
    )
    expect(open).not.toContain('此工作区不支持')
  })
})
