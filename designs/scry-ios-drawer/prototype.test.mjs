// 这些检查只证明原型的列表规则，不证明真实 iOS 行为或主机能力。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copy, fixtures } from './copy.mjs'
import {
  initialState, RECENT_LIMIT, attention, pinned, recents, projectGroups, visibleCount,
  canOpen, togglePin, renameSession, archiveSession, restoreSession, toggleProject, relativeTime, matches,
  renderBoard, toolRows, canOpenTool, analyticsMetrics
} from './prototype.mjs'

const ids = sessions => sessions.map(session => session.id)

test('等待决定的会话提到最上面，并从其余列表移出', () => {
  const state = initialState()
  assert.deepEqual(ids(attention(state)), ['s3'])
  assert.ok(!ids(recents(state)).includes('s3'))
  assert.ok(!ids(pinned(state)).includes('s3'))
  assert.ok(!projectGroups(state).flatMap(group => ids(group.sessions)).includes('s3'))
})

test('置顶跨项目、按置顶时间倒序，且不进最近与项目分组', () => {
  const state = initialState()
  assert.deepEqual(ids(pinned(state)), ['s4', 's5'])
  assert.ok(!ids(recents(state)).includes('s4'))
  assert.ok(!projectGroups(state).some(group => ids(group.sessions).includes('s5')))
})

test('最近按时间倒序，且排除等待决定与置顶', () => {
  const state = initialState()
  assert.deepEqual(ids(recents(state)), ['s1', 's2', 's6', 's7', 's8', 's9', 's10', 's11'])
  assert.equal(visibleCount(state), fixtures.sessions.length)
})

test('项目分组按最近活跃排序，组内按时间倒序', () => {
  const state = initialState()
  const groups = projectGroups(state)
  assert.deepEqual(groups.map(group => group.name), ['scry', 'release'])
  assert.deepEqual(ids(groups[0].sessions), ['s1', 's2', 's6', 's7', 's9', 's10', 's11'])
  assert.equal(groups.reduce((count, group) => count + group.sessions.length, 0), recents(state).length)
})

test('搜索匹配标题、项目、Provider 与目录，并丢掉空分组', () => {
  const state = initialState({ query: 'payment' })
  assert.deepEqual(ids(recents(state)), [])
  assert.deepEqual(ids(pinned(state)), ['s5'])
  assert.deepEqual(projectGroups(state), [])
  assert.equal(visibleCount(state), 1)
  assert.ok(matches(state.sessions.find(session => session.id === 's5'), ' Claude '))
  assert.ok(matches(state.sessions.find(session => session.id === 's7'), 'scry'))
})

test('置顶与取消置顶在最近和置顶之间移动同一行', () => {
  const pinnedState = togglePin(initialState(), 's1')
  assert.deepEqual(ids(pinned(pinnedState)).slice(0, 2), ['s1', 's4'])
  assert.ok(!ids(recents(pinnedState)).includes('s1'))
  const unpinned = togglePin(pinnedState, 's1')
  assert.ok(ids(recents(unpinned)).includes('s1'))
})

test('重命名去掉首尾空白，空标题不改动', () => {
  const state = renameSession(initialState(), 's6', '  新的会话标题  ')
  assert.equal(state.sessions.find(session => session.id === 's6').title, '新的会话标题')
  const unchanged = renameSession(state, 's6', '   ')
  assert.equal(unchanged.sessions.find(session => session.id === 's6').title, '新的会话标题')
})

test('存档从所有列表移除，恢复后回到列表', () => {
  const archived = archiveSession(initialState(), 's1')
  assert.ok(!ids(archived.sessions).includes('s1'))
  assert.deepEqual(ids(archived.archived), ['s1'])
  assert.equal(visibleCount(archived), fixtures.sessions.length - 1)
  const restored = restoreSession(archived, 's1')
  assert.ok(ids(restored.sessions).includes('s1'))
  assert.deepEqual(restored.archived, [])
})

test('没有外部会话 ID 的行不可打开', () => {
  const state = initialState()
  assert.equal(canOpen(state.sessions.find(session => session.id === 's11')), false)
  assert.equal(canOpen(state.sessions.find(session => session.id === 's1')), true)
})

test('项目折叠是纯状态切换', () => {
  const state = toggleProject(initialState(), fixtures.sessions[0].cwd)
  assert.deepEqual(state.collapsed, [fixtures.sessions[0].cwd])
  assert.deepEqual(toggleProject(state, fixtures.sessions[0].cwd).collapsed, [])
})

test('最近列表上限与相对时间分档', () => {
  assert.equal(RECENT_LIMIT, 4)
  assert.equal(relativeTime(0.4), '刚刚')
  assert.equal(relativeTime(6), '6 分钟前')
  assert.equal(relativeTime(120), '2 小时前')
  assert.equal(relativeTime(60 * 30), '昨天')
  assert.equal(relativeTime(60 * 24 * 5), '本周')
  assert.equal(relativeTime(60 * 24 * 40), '更早')
})

test('每块画板都能渲染，且没有 undefined 或缺失的发送按钮', () => {
  for (const id of copy.boards.map(meta => meta.id)) {
    const html = renderBoard(id)
    assert.ok(!html.includes('undefined'), `${id} 渲染出现 undefined`)
    if (['analytics', 'llm', 'skills', 'mcp', 'meta'].includes(id)) continue
    assert.ok(html.includes('aria-label="发送"'), `${id} 缺少发送按钮`)
    assert.ok(html.includes('class="composer"'), `${id} 缺少输入区`)
  }
})

test('切换画板到项目视图后仍能渲染完整分组', () => {
  const html = renderBoard('recent')
  assert.ok(html.includes('查看全部 11 个会话'))
  const projects = renderBoard('projects')
  assert.ok(projects.includes('class="group-name">scry<'))
  assert.ok(projects.includes('data-act="new-in-project"'))
})

test('工具页固定五个面板，顺序与 Mac 侧栏一致', () => {
  assert.deepEqual(toolRows().map(row => row.id), ['analytics', 'llm', 'skills', 'mcp', 'meta'])
})

test('能力不成立的工具行不可点，且写明缺失的是哪项能力', () => {
  for (const row of toolRows()) assert.equal(canOpenTool(row), true, `${row.id} 默认应可用`)
  const gated = toolRows({ skills: false, mcp: false })
  assert.equal(canOpenTool(gated.find(row => row.id === 'skills')), false)
  assert.equal(gated.find(row => row.id === 'skills').statusText, `不可用 · ${copy.toolGated.skills}`)
  assert.equal(gated.find(row => row.id === 'mcp').statusText, `不可用 · ${copy.toolGated.mcp}`)
})

test('缺失的指标保持 unavailable，不折成 0', () => {
  const metrics = analyticsMetrics()
  assert.equal(metrics.length, 5)
  const missing = metrics.filter(metric => metric.unavailable)
  assert.deepEqual(missing.map(metric => metric.label), ['缓存写入'])
  assert.equal(missing[0].value, '不可用')
  assert.ok(metrics.every(metric => metric.value !== '0'))
})

test('工具页渲染五个面板行与只读说明', () => {
  const tools = renderBoard('tools')
  for (const row of copy.toolRows) assert.ok(tools.includes(`>${row.label}<`), `工具页缺少 ${row.label}`)
  assert.ok(tools.includes(copy.toolsNote))
  assert.ok(tools.includes('data-act="tool-analytics"'))
})

test('五个面板屏都渲染出来源时间与 Mac 面板结构', () => {
  for (const kind of ['analytics', 'llm', 'skills', 'mcp', 'meta']) {
    const html = renderBoard(kind)
    assert.ok(html.includes(copy.panel.provenance(copy.hostOne, '21:32')), `${kind} 缺少来源与读取时间`)
    assert.ok(html.includes('class="panel-body"'), `${kind} 缺少面板容器`)
    assert.ok(html.includes('aria-label="返回"'), `${kind} 缺少返回`)
    assert.ok(!html.includes('undefined'), `${kind} 出现 undefined`)
  }
})

test('分析面板与 Mac 同序：总览、每日、按 Provider、Token、明细', () => {
  const html = renderBoard('analytics')
  const order = [copy.analytics.totalLabel, copy.analytics.composition, copy.analytics.dailyCost,
    copy.analytics.byProvider, copy.analytics.tokens, copy.analytics.details]
  const positions = order.map(label => html.indexOf(label))
  positions.forEach((position, index) => {
    assert.ok(position > 0, `缺少 ${order[index]}`)
    if (index) assert.ok(position > positions[index - 1], `${order[index]} 顺序与 Mac 不一致`)
  })
  assert.ok(html.includes('is-approximate') && html.includes('is-lower-bound'), '近似与下界标记缺失')
  assert.equal((html.match(/<dt>/g) || []).length >= 5, true)
})

test('LLM 性能：运行中会话在历史之前，含平均速度、首字与模型对比', () => {
  const html = renderBoard('llm')
  assert.ok(html.indexOf(copy.llm.runningRegion) < html.indexOf(copy.llm.history('')))
  assert.ok(html.includes(copy.llm.average) && html.includes(copy.llm.firstToken))
  assert.ok(html.includes(copy.llm.comparison))
  assert.ok(html.includes('tok/s'))
  assert.equal((html.match(/class="p-run"/g) || []).length, fixtures.panels.llm.running.length)
})

test('技能：Provider 页计数为 0 时不出现空页，并给出只读脚注', () => {
  const html = renderBoard('skills')
  assert.ok(html.includes(copy.skills.scopes.project) && html.includes(copy.skills.scopes.user))
  assert.ok(!html.includes(copy.skills.scopes.provider), '计数 0 的来源页不应出现')
  assert.ok(html.includes(copy.skills.footnoteBody))
  assert.ok(html.includes(copy.panel.shown(fixtures.panels.skills.shown, fixtures.panels.skills.total)))
})

test('MCP 面板是只读观测：策略/发现/inventory/审计齐全，没有允许或拒绝按钮', () => {
  const html = renderBoard('mcp')
  for (const label of [copy.mcp.liveTitle, copy.mcp.policy, copy.mcp.criticalHigh, copy.mcp.policyBlocks,
    copy.mcp.findings, copy.mcp.inventory, copy.mcp.policyAudit]) {
    assert.ok(html.includes(label), `缺少 ${label}`)
  }
  assert.ok(!html.includes('>允许</button>') && !html.includes('>拒绝</button>'), '面板不该提供允许/拒绝动作')
  assert.ok(html.includes(copy.mcp.refreshLive) && html.includes(copy.mcp.scan), '缺刷新或扫描')
  assert.ok(html.includes('不是官方认证'), '缺报告证据说明')
})

test('Meta Prompts：列表可复制，详情有字数、放入输入框与 Mac 侧编辑说明', () => {
  const html = renderBoard('meta')
  assert.ok(html.includes(copy.meta.count(fixtures.panels.meta.prompts.length)))
  assert.ok(html.includes(copy.meta.insert))
  assert.match(html, /\d+ 字 · 纯文本/)
  assert.ok(html.includes(copy.meta.edit) && html.includes(copy.meta.remove))
  assert.ok(html.includes(copy.panel.macOnly), '编辑与删除要说明在 Mac 上处理')
})
