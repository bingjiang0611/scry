import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, sessionAttentionKey, Sidebar } = shared

describe('Sidebar 项目分组', () => {
  it('项目侧栏不显示已存档对话，只有存档时显示空状态', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/repo', name: 'repo', mtime: 1, sessions: [],
          conversations: [{ id: 'archived', cwd: '/repo', title: '已归档的标题', revision: 1, turnCount: 1, archivedAt: 1, pinnedAt: 1 }]
        }]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )
    expect(html).not.toContain('已存档对话')
    expect(html).not.toContain('已归档的标题')
    expect(html).toContain('暂无会话')
  })

  it('Skill 和 MCP 与分析同组展示，入口不读取数量或连接状态', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        onAnalytics={() => {}}
        onSkills={() => {}}
        onMcp={() => {}}
        onSettings={() => {}}
      />
    )
    expect(html).toContain('<nav class="sb-nav" aria-label="主要视图">')
    expect(html).toContain('title="Skills"')
    expect(html).toContain('title="MCP"')
    expect(html).toContain('aria-label="MCP"')
    expect(html).not.toContain('sb-navmeta')
    expect(html).not.toContain('sb-navdot')
    expect(html).not.toContain('已连接')
    expect(html).toContain('class="sb-navitem sb-settings"')
    expect(html).not.toContain('class="kbd"')
    expect(html).not.toContain('深色')
    expect(html).not.toContain('浅色')
    expect(html).not.toContain('诊断')
    expect(html.indexOf('分析')).toBeLessThan(html.indexOf('title="Skills"'))
  })

  it('同名项目保留路径标识但 hover 不显示具体路径', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[
          {
            cwd: '/Users/example/IdeaProjects/sample-workspace',
            name: 'sample-workspace',
            mtime: 2,
            sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 2, preview: '当前目录路径是什么', count: 1 }]
          },
          {
            cwd: '/Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace',
            name: 'sample-workspace',
            mtime: 1,
            sessions: [{ sessionId: 's2', externalSessionId: 's2', providerId: 'codex', mtime: 1, preview: '当前处于哪个目录', count: 1 }]
          }
        ]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        onAnalytics={() => {}}
        analyticsActive
      />
    )

    expect(html).toContain('<nav class="sb-nav" aria-label="主要视图">')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('<button type="button" class="sb-proj-head')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('class="ico sb-project-folder"')
    expect(html).toContain('aria-label="sample-workspace · /Users/example/IdeaProjects/sample-workspace"')
    expect(html).toContain('aria-label="sample-workspace · /Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace"')
    expect(html).toContain('data-project-path="/Users/example/IdeaProjects/sample-workspace"')
    expect(html).toContain('data-project-path="/Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace"')
    expect(html).not.toContain('class="ppath"')
    expect(html).not.toContain('title="sample-workspace')
  })

  it('没有会话的项目仍保留，并提供 Codex 风格的行内新建按钮', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/empty-project',
          name: 'empty-project',
          mtime: 2,
          sessions: [],
          pinnedAt: 10
        }]}
        activeCwd="/Users/example/empty-project"
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        onNewProjectChat={() => {}}
        onToggleProjectPin={() => {}}
        onRenameProject={() => {}}
        onRemoveProject={() => {}}
        onRevealProject={() => {}}
      />
    )

    expect(html).not.toContain('aria-label="添加项目"')
    expect(html).toContain('暂无会话')
    expect(html).not.toContain('class="cnt"')
    expect(html).not.toContain('class="pcnt"')
    expect(html).toContain('aria-label="在 empty-project 中新建会话 · /Users/example/empty-project"')
    expect(html).toContain('class="sb-proj-act sb-proj-new"')
    expect(html).toContain('class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"')
    expect(html).toContain('aria-label="管理项目 empty-project · /Users/example/empty-project"')
    expect(html.indexOf('class="sb-proj-act sb-proj-new"')).toBeLessThan(html.indexOf('class="sb-proj-act sb-proj-more"'))
    expect(html).toContain('class="sb-proj-head on"')
    expect(html).toContain('class="ico sb-project-pin"')
  })

  it('不绑定项目会话以独立活动分组出现在左侧', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '',
          name: 'Chats',
          mtime: 2,
          sessions: [{ sessionId: 's-unbound', externalSessionId: 's-unbound', providerId: 'qoder', mtime: 2, preview: '无工作目录任务', count: 1 }]
        }]}
        activeCwd={null}
        activeSessionId="s-unbound"
        activeProviderId="qoder"
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).not.toContain('class="sb-proj-head on"')
    expect(html).not.toContain('class="sb-proj-row active"')
    expect(html).toContain('aria-label="Chats · 未关联工作目录"')
    expect(html).not.toContain('class="ppath"')
    expect(html).toContain('class="sb-sess active"')
    expect(html).toContain('class="sb-session-main"')
    expect(html).toContain('<span class="provider-glyph sb-provider" data-provider="qoder" role="img" aria-label="Qoder"')
    expect(html).toContain('<span class="sb-sesstext">无工作目录任务</span>')
    expect(html).toContain('class="sb-session-meta"')
    expect(html).toContain('无工作目录任务')
  })

  it('仅给真实 active run 对应的会话展示运行中标识', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[
          {
            cwd: '/Users/example/project',
            name: 'project',
            mtime: 2,
            sessions: [
              { sessionId: 's1', runId: 'run-active', providerId: 'claude', mtime: 2, preview: '运行中', count: 1 },
              { sessionId: 's2', runId: 'run-done', providerId: 'claude', mtime: 1, preview: '已结束', count: 1 }
            ]
          }
        ]}
        activeCwd="/Users/example/project"
        activeSessionId="s1"
        activeProviderId="claude"
        runningRunIds={new Set(['run-active'])}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('class="sb-sess active running"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在运行"')
    expect(html.match(/class="sb-running"/g)).toHaveLength(1)
  })

  it('待回答会话用明确徽标替代运行转圈', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/project',
          name: 'project',
          mtime: 2,
          sessions: [
            { sessionId: 's1', runId: 'run-question', providerId: 'pi', mtime: 2, preview: '继续', count: 1 }
          ]
        }]}
        activeCwd="/Users/example/project"
        activeSessionId="s1"
        activeProviderId="pi"
        runningRunIds={new Set(['run-question'])}
        waitingQuestionRunIds={new Set(['run-question'])}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-sess active running waiting-answer"')
    expect(html).toContain('class="sb-question-pending" role="status" aria-label="等待你的回答"')
    expect(html).toContain('待回答')
    expect(html).not.toContain('class="sb-running"')
  })

  it('完成但未查看的会话显示蓝点，其他会话不显示', () => {
    const cwd = '/Users/example/project'
    const unreadKey = sessionAttentionKey({ providerId: 'claude', cwd, sessionId: 's2' })
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd,
          name: 'project',
          mtime: 2,
          sessions: [
            { sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 2, preview: '已查看', count: 1 },
            { sessionId: 's2', externalSessionId: 's2', providerId: 'claude', mtime: 1, preview: '刚完成', count: 1 }
          ]
        }]}
        activeCwd={cwd}
        unreadSessionKeys={new Set([unreadKey])}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-sess unread"')
    expect(html).toContain('class="sb-unread" role="status" aria-label="有新结果，未查看"')
    expect(html.match(/class="sb-unread"/g)).toHaveLength(1)
  })

  it('置顶会话进入独立分组并带项目名，不在原项目分组里重复出现', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[
          {
            cwd: '/Users/example/rate-native',
            name: 'rate-native',
            mtime: 3,
            sessions: [
              { sessionId: 'pinned-1', externalSessionId: 'pinned-1', providerId: 'codex', mtime: 3, preview: '启动需求交付流程', count: 2, pinnedAt: 20 },
              { sessionId: 'plain-1', externalSessionId: 'plain-1', providerId: 'codex', mtime: 2, preview: '普通会话', count: 1 }
            ]
          },
          {
            cwd: '/Users/example/scry',
            name: 'scry',
            mtime: 1,
            sessions: [
              { sessionId: 'pinned-2', externalSessionId: 'pinned-2', providerId: 'claude', mtime: 1, preview: '侧边栏置顶方案', count: 1, pinnedAt: 30 }
            ]
          }
        ]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('<div class="sb-section">置顶</div>')
    expect(html).toContain('class="sb-pinned"')
    // 置顶按 pinnedAt 倒序，最近置顶的排最前。
    expect(html.indexOf('侧边栏置顶方案')).toBeLessThan(html.indexOf('启动需求交付流程'))
    expect(html).toContain('<span class="sb-sess-proj">rate-native</span>')
    expect(html).toContain('<span class="sb-sess-proj">scry</span>')
    // 项目目录独立于会话保留：scry 的会话被置顶后，项目仍显示为“会话已置顶”。
    expect(html).toContain('会话已置顶')
    expect(html).not.toContain('class="cnt"')
    expect(html).not.toContain('class="pcnt"')
    expect(html).not.toContain('class="sb-count"')
    expect(html.match(/class="sb-sess-proj"/g)).toHaveLength(2)
  })

  it('会话行提供置顶与存档按钮，且不再有右键删除菜单', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/project',
          name: 'project',
          mtime: 1,
          sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 1, preview: '会话一', count: 1 }]
        }]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-sess-row"')
    expect(html).toContain('aria-label="置顶会话：会话一"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="存档会话：会话一"')
    // 操作按钮必须是会话按钮的兄弟节点：button 里不能再嵌 button。
    expect(html).toContain('</button><span class="sb-sess-acts">')
    expect(html).not.toContain('ctxmenu')
    expect(html).not.toContain('删除会话')
    expect(html).not.toContain('aria-haspopup="menu"')
  })

  it('已置顶的会话按钮标注取消置顶', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/project',
          name: 'project',
          mtime: 1,
          sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 1, preview: '会话一', count: 1, pinnedAt: 5 }]
        }]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-act on"')
    expect(html).toContain('aria-label="取消置顶：会话一"')
    expect(html).toContain('aria-pressed="true"')
  })

  it('存档后给出可撤销提示', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        archiveUndo={{ preview: '会话一' }}
        onUndoArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-undo"')
    expect(html).toContain('已存档「会话一」')
    expect(html).toContain('撤销')
  })
})