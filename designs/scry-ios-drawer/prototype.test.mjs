// 这些检查只证明原型的列表规则，不证明真实 iOS 行为或主机能力。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialState, RECENT_LIMIT, attention, pinned, recents, projectGroups, visibleCount,
  canOpen, togglePin, renameSession, archiveSession, restoreSession, toggleProject, relativeTime, matches,
  renderBoard
} from './prototype.mjs'
import { fixtures } from './copy.mjs'

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
  for (const id of ['home', 'recent', 'projects', 'evidence']) {
    const html = renderBoard(id)
    assert.ok(!html.includes('undefined'), `${id} 渲染出现 undefined`)
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
