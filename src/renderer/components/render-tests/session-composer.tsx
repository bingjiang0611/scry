import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, createRef, enqueuePrompt, resetQueuedPromptControl, sessionComposerDraftKey, updateSessionPromptQueue, dequeueStartedPromptFromSessions, ChatView, filterSlashCommands, turn, RUN_CONTROL_PROPS, renderWelcome } = shared
type QueuedPrompt = shared.QueuedPrompt

describe('AssistantTurn 渲染：trace 树 / footer / 文件足迹', () => {
  it('ChatView 能把待跳转轮次标记成滚动目标', () => {
    const chatHtml = renderToStaticMarkup(
      <ChatView
        turns={[turn]}
        selectedId={null}
        scrollRef={createRef<HTMLDivElement>()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        cwd="/tmp/project"
        recent={[]}
        agents={[]}
        selectedAgentId="claude"
        {...RUN_CONTROL_PROPS}
        runControls={{ model: { id: 'test-model' }, effort: 'high', permissionMode: 'default' }}
        input=""
        busy={false}
        draftAttachments={[]}
        queuedPrompts={[]}
        slashOpen={false}
        slashLoading={false}
        slashCmds={[]}
        slashSel={0}
        focusedTurnRunId="r1"
        onTurnRef={() => {}}
        onSelect={() => {}}
        onInput={() => {}}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => {}}
        onPickSlash={() => {}}
        onSlashSel={() => {}}
        onHideSlash={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onPasteImages={() => {}}
        onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={() => {}}
        onSelectAgent={() => {}}
        onRescan={() => {}}
      />
    )
    expect(chatHtml).toContain('data-run-id="r1"')
    expect(chatHtml).toContain('turn-jump-target')
    expect(chatHtml).toContain('aria-label="选择 Model 与 Effort"')
    expect(chatHtml).toContain('class="model-effort-model">Test Model · test-model')
    expect(chatHtml).toContain('class="model-effort-effort">高')
    expect(chatHtml).toContain('aria-label="权限"')
    const controls = chatHtml.match(/<div class="composer-controls"[\s\S]*?<div class="spacer"/u)?.[0] ?? ''
    const actions = chatHtml.match(/<div class="composer-action-controls"[\s\S]*?<button type="button" class="send"/u)?.[0] ?? ''
    expect(chatHtml).not.toContain('class="composer-top"')
    expect(chatHtml).not.toContain('class="composer-context"')
    expect(chatHtml).not.toContain('class="wdpick"')
    expect(controls).toContain('role="group"')
    expect(controls).toContain('aria-label="权限配置"')
    expect(controls).not.toContain('class="wdpick"')
    expect(controls).not.toContain('class="clipick"')
    expect(actions).toContain('class="clipick"')
    expect(actions).toContain('class="model-effort-picker"')
    expect(actions.indexOf('class="clipick"')).toBeLessThan(actions.indexOf('class="model-effort-picker"'))
    expect(chatHtml).toContain('aria-label="发送"')
    expect(chatHtml).toContain('M12 19V5m-7 7 7-7 7 7')
  })
it('Pi 完全访问必须由用户明确选择，不把唯一权限静默当成当前值', () => {
    const reason = '当前 Provider 不支持所选模型、推理强度或权限，请重新选择'
    const chatHtml = renderWelcome({
      selectedAgentId: 'pi:default',
      runControls: { permissionMode: 'default' },
      runControlCatalog: {
        models: [{ model: { id: 'pi-model' }, label: 'Pi', efforts: [] }],
        permissions: [{ id: 'full_access', label: '本机完全访问', description: '继承本机用户权限' }]
      },
      sendBlockedReason: reason,
      input: '准备发送'
    })

    expect(chatHtml).toContain('class="rc-value" aria-hidden="true">请选择权限</span>')
    expect(chatHtml).toContain('aria-description="请选择权限：当前 Provider 需要你明确选择一个受支持的权限模式"')
    expect(chatHtml).not.toContain('class="rc-value" aria-hidden="true">本机完全访问</span>')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toMatch(/class="send"[^>]*disabled=""/)
  })
it('Composer 直接说明阻塞发送的原因，并关联输入与发送按钮', () => {
    const reason = '当前 Provider 不可发送'
    const chatHtml = renderWelcome({ input: '保留这份草稿', sendBlockedReason: reason })
    const sendButton = chatHtml.match(/<button[^>]*class="send"[^>]*>/u)?.[0] ?? ''
    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toContain('role="status"')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).toMatch(/aria-label="描述任务"[^>]*aria-describedby="composer-status"/)
    expect(sendButton).toContain('aria-describedby="composer-status"')
    expect(sendButton).toContain(`title="${reason}"`)
    expect(sendButton).toContain('disabled=""')
  })
it('发送失败后展示精确错误，不用静默吞掉点击结果', () => {
    const chatHtml = renderWelcome({
      input: '保留这份草稿',
      composerError: 'Provider 启动失败：认证已过期'
    })

    expect(chatHtml).toContain('class="composer-status is-error"')
    expect(chatHtml).toContain('role="alert"')
    expect(chatHtml).toContain('Provider 启动失败：认证已过期')
    expect(chatHtml).toMatch(/class="send"[^>]*aria-describedby="composer-status"/)
    expect(chatHtml).not.toMatch(/class="send"[^>]*disabled=""/)
  })
it('可选模型后台读取时保持自动模型语义，不把 composer 伪装成阻塞态', () => {
    const chatHtml = renderWelcome({
      agents: [{
        id: 'claude', name: 'Claude Code', bin: 'claude', path: '/usr/local/bin/claude',
        health: { state: 'ready', transport: 'Agent SDK' }
      }],
      runControlsLoading: true,
      runControlCatalog: {
        models: [],
        permissions: RUN_CONTROL_PROPS.runControlCatalog.permissions
      }
    })

    expect(chatHtml).toMatch(/aria-label="选择 Model 与 Effort"[^>]*aria-busy="true"/)
    expect(chatHtml).toContain('自动模型')
    expect(chatHtml).toContain('正在后台读取可选模型；当前使用 Provider 默认模型')
    expect(chatHtml).not.toContain('读取模型…')
    expect(chatHtml).not.toContain('id="composer-status"')
    expect(chatHtml).not.toContain('当前 Provider 不可发送；草稿会保留')
    expect(chatHtml).toContain('aria-label="发送"')
  })
it('缓存选择失效时说明原因并禁用发送', () => {
    const reason = '最后已知模型目录不包含当前模型、推理强度或权限，请重新选择'
    const chatHtml = renderWelcome({ input: '准备发送', sendBlockedReason: reason })

    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).toMatch(/class="send"[^>]*disabled=""/)
  })
it('Provider 确认不可用时在 Composer 展示探测错误', () => {
    const reason = '版本探测被信号 SIGKILL 终止'
    const chatHtml = renderWelcome({
      agents: [{
        id: 'claude', name: 'Claude Code', bin: 'claude', path: '/usr/local/bin/claude',
        health: { state: 'unavailable', transport: 'Agent SDK', lastError: 'CLI 不可用' }
      }],
      runControlsLoading: true,
      sendBlockedReason: reason,
      input: '准备发送'
    })
    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).not.toContain('当前 Provider 不可发送；草稿会保留')
  })
it('切换会话时保持无提示加载态，不闪过新会话引导页或旧 transcript', () => {
    const chatHtml = renderWelcome({
      sessionLoading: true,
      turns: [{ ...turn, runId: 'old-run', userText: '旧会话内容' }],
      input: '目标会话自己的草稿'
    })

    expect(chatHtml).toContain('aria-busy="true"')
    expect(chatHtml).not.toContain('正在打开对话')
    expect(chatHtml).not.toContain('草稿已保留')
    expect(chatHtml).not.toContain('开始一次可追溯执行')
    expect(chatHtml).not.toContain('旧会话内容')
    expect(chatHtml).toContain('目标会话自己的草稿')
    expect(chatHtml).toMatch(/class="send"[^>]*disabled=""/)
  })
it('斜杠菜单只展示当前输入匹配项，且标题不展示数量', () => {
    const commands = [
      { name: 'browser-use', description: 'Browser automation' },
      { name: 'code-fix', description: 'Fix code' },
      { name: 'nextcr-code-review', description: 'Review code' }
    ]
    expect(filterSlashCommands('/code', commands).map((command) => command.name)).toEqual([
      'code-fix',
      'nextcr-code-review'
    ])

    const chatHtml = renderWelcome({
      cwd: '/tmp/project',
      agents: [{
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        path: '/usr/local/bin/claude',
        version: '2.1.170',
        transport: 'local-cli',
        health: { state: 'ready', transport: 'local-cli' }
      }],
      input: '/code',
      slashOpen: true,
      slashCmds: commands
    })
    expect(chatHtml).toContain('<span>Commands</span>')
    expect(chatHtml).toContain('今天想在 <span>project</span> 中构建什么？')
    expect(chatHtml).toContain('welcome-hero-icon')
    expect(chatHtml).not.toContain('welcome-provider-field')
    expect(chatHtml).not.toContain('Provider 可用')
    expect(chatHtml).not.toContain('重新扫描 PATH')
    // Provider 选择仍保留在 composer，项目选择也不在 welcome 正文重复出现。
    expect(chatHtml).toContain('data-agent-id="claude"')
    expect(chatHtml).toContain('class="provider-glyph" data-provider="claude"')
    expect(chatHtml).not.toContain('class="welcome-context"')
    expect(chatHtml).toContain('/tmp/project')
    expect(chatHtml).not.toContain('运行上下文')
    expect(chatHtml).not.toContain('最近工作目录')
    // 双标题已收敛：composer 不再顶一个「告诉 Agent 要完成什么」
    expect(chatHtml).not.toContain('告诉 Agent 要完成什么')
    expect(chatHtml).not.toContain('welcome-composer-heading')
    expect(chatHtml).toContain('aria-label="描述任务"')
    expect(chatHtml).not.toContain('Commands ·')
    expect(chatHtml).not.toContain('browser-use')
    expect(chatHtml).toContain('code-fix')
    expect(chatHtml).toContain('nextcr-code-review')
  })
it('ChatView 不在空态展示 Provider 探测和健康状态', () => {
    const html = renderWelcome({
      selectedAgentId: 'pi:25f2d533d0a8b391',
      agents: [{
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        path: '/usr/local/bin/claude',
        health: { state: 'unavailable', transport: 'Agent SDK' }
      }, {
        id: 'pi:25f2d533d0a8b391',
        name: 'Pi · pi-agent',
        bin: 'pi-agent',
        path: '/Users/example/dev-agent/pi-agent/bin/pi-agent',
        health: { state: 'ready', transport: 'JSONL RPC subprocess' }
      }]
    })

    expect(html).toContain('今天想构建什么？')
    expect(html).toContain('data-agent-id="pi:25f2d533d0a8b391"')
    expect(html).toContain('class="provider-glyph" data-provider="pi"')
    expect(html).not.toContain('Provider 可用')
    expect(html).not.toContain('Provider 不可用')
    expect(html).not.toContain('data-health=')
    expect(html).not.toContain('重新扫描 PATH')
    expect(html).not.toContain('/usr/local/bin/claude')
  })
it('ChatView 渲染运行中输入队列和图片附件', () => {
    const chatHtml = renderToStaticMarkup(
      <ChatView
        turns={[{ ...turn, attachments: [{ kind: 'image', name: 'sent.png', mimeType: 'image/png', dataBase64: 'aQ==' }] }]}
        selectedId={null}
        scrollRef={createRef<HTMLDivElement>()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        cwd="/tmp/project"
        recent={[]}
        agents={[]}
        selectedAgentId="claude"
        agentLocked
        {...RUN_CONTROL_PROPS}
        input=""
        busy
        draftAttachments={[
          { id: 'draft-1', kind: 'image', name: 'draft.png', mimeType: 'image/png', dataBase64: 'aQ==', previewUrl: 'data:image/png;base64,aQ==' }
        ]}
        queuedPrompts={[{
          messageId: 'queued-render',
          text: '继续检查',
          attachments: [{ kind: 'image', name: 'queued.png', mimeType: 'image/png', dataBase64: 'aQ==' }],
          request: { providerId: 'claude', permissionMode: 'default' }
        }]}
        steerCapability={{ status: 'available', attachments: true }}
        onSteerQueuedPrompt={() => {}}
        slashOpen={false}
        slashLoading={false}
        slashCmds={[]}
        slashSel={0}
        onSelect={() => {}}
        onInput={() => {}}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => {}}
        onPickSlash={() => {}}
        onSlashSel={() => {}}
        onHideSlash={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onPasteImages={() => {}}
        onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={() => {}}
        onSelectAgent={() => {}}
        onRescan={() => {}}
      />
    )
    expect(chatHtml).toContain('等待运行')
    expect(chatHtml).toContain('当前任务结束后依次发送')
    expect(chatHtml).toContain('queue-count">1')
    expect(chatHtml).toContain('aria-label="移除队列第 1 条消息"')
    expect(chatHtml).toContain('↳')
    expect(chatHtml).toContain('不中断模型，将这条消息补充给当前任务')
    expect(chatHtml).toContain('title="当前状态暂不能切换 Agent"')
    expect(chatHtml).toMatch(/class="clibtn"[^>]*disabled=""/)
    expect(chatHtml).toMatch(/aria-label="选择 Model 与 Effort"(?![^>]*disabled)/)
    expect(chatHtml).toMatch(/aria-label="权限"(?![^>]*disabled)/)
    expect(chatHtml).toContain('继续检查')
    expect(chatHtml).toContain('draft.png')
    expect(chatHtml).toContain('aria-label="放大查看图片 sent.png"')
    expect(chatHtml).not.toContain('<figcaption>sent.png</figcaption>')
    expect(chatHtml).toContain('class="user-attachment"')
    // 历史缩略图与草稿预览都按需解码：CSP 与远程图片阻断不变，只改解码时机。
    expect(chatHtml.match(/<img[^>]*loading="lazy"[^>]*decoding="async"/g)?.length).toBe(2)
    expect(chatHtml).toContain('排队')
  })
it('编辑队列消息时行内动作让位给取消编辑，并说明会自动跳过这条', () => {
    const queuedPrompts: QueuedPrompt[] = [
      { messageId: 'q1', text: '第一条', attachments: [], request: { providerId: 'claude' } },
      { messageId: 'q2', text: '第二条', attachments: [], request: { providerId: 'claude' } }
    ]
    const editing = renderWelcome({
      busy: true,
      queuedPrompts,
      editingQueuedId: 'q1',
      input: '第一条',
      onEditQueuedPrompt: () => {},
      onCancelQueuedPromptEdit: () => {}
    })
    expect(editing).toContain('class="queue-item is-editing"')
    expect(editing).toContain('编辑队列第 1 条 · 发送后移到队尾 · 自动发送会先跳过这条')
    expect(editing).toContain('取消编辑')
    // 编辑中的行不再提供行内动作，铅笔跳到下一条；「下一个」高亮跟着真实发送顺序走。
    expect(editing).not.toContain('aria-label="编辑队列第 1 条消息"')
    expect(editing).toContain('aria-label="编辑队列第 2 条消息"')
    expect(editing).toContain('class="queue-item is-next"')
    expect(editing.indexOf('is-next')).toBeGreaterThan(editing.indexOf('is-editing'))

    const blocked = renderWelcome({
      busy: true,
      queuedPrompts,
      input: '正在输入',
      movedQueuedId: 'q2',
      onEditQueuedPrompt: () => {}
    })
    // 不静默覆盖用户正在打的字：按钮禁用并在 title 里给出原因。
    expect(blocked).toContain('输入框里已有内容：先发送或清空，再编辑队列消息')
    expect(blocked).toMatch(/class="queue-edit"[^>]*disabled/)
    expect(blocked).toContain('编辑后已移到队尾')
    expect(blocked).toContain('aria-label="编辑队列第 1 条消息"')
  })
it('切换会话只重置启动控制，不清除按会话隔离的队列', () => {
    expect(resetQueuedPromptControl(7)).toEqual({ generation: 8, pending: false, inFlight: false })

    const aKey = sessionComposerDraftKey({ providerId: 'pi', cwd: '/repo', sessionId: 'a' })
    const bKey = sessionComposerDraftKey({ providerId: 'pi', cwd: '/repo', sessionId: 'b' })
    const aPrompt = enqueuePrompt([], 'A 会话后续任务', [], { providerId: 'pi' })[0]
    const bPrompt = enqueuePrompt([], 'B 会话后续任务', [], { providerId: 'pi' })[0]
    let queues = updateSessionPromptQueue(new Map(), aKey, () => [aPrompt])
    queues = updateSessionPromptQueue(queues, bKey, () => [bPrompt])

    expect(queues.get(aKey)?.map((prompt) => prompt.text)).toEqual(['A 会话后续任务'])
    expect(queues.get(bKey)?.map((prompt) => prompt.text)).toEqual(['B 会话后续任务'])
    expect(dequeueStartedPromptFromSessions(queues, aPrompt).get(bKey)?.[0]).toBe(bPrompt)
  })


})