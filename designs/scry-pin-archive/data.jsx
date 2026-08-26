// 模拟数据：字段对齐 preload 的 SessionMeta / ProjectMeta，并新增 pinnedAt / archivedAt 两个可选字段。
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.now()

const SESSIONS = [
  // rate-native
  { sessionId: 'rn-01', providerId: 'codex', preview: '启动需求交付流程 85879680', count: 42, mtime: NOW - 18 * MINUTE, pinnedAt: NOW - 3 * DAY, runId: 'run-rn-01' },
  { sessionId: 'rn-02', providerId: 'claude', preview: '定位评价需求接口及缺失数据', count: 16, mtime: NOW - 3 * HOUR },
  { sessionId: 'rn-03', providerId: 'codex', preview: '完成需求84850862开发', count: 61, mtime: NOW - 5 * HOUR },
  { sessionId: 'rn-04', providerId: 'qoder', preview: '增加天猫商家星级筛选', count: 9, mtime: NOW - 26 * HOUR },
  { sessionId: 'rn-05', providerId: 'claude', preview: '排查商家后台空白页', count: 7, mtime: NOW - 2 * DAY },
  { sessionId: 'rn-06', providerId: 'codex', preview: '下午跑需求的时候遇到了这个问题 修复下', count: 12, mtime: NOW - 21 * HOUR, archivedAt: NOW - 20 * HOUR },
  { sessionId: 'rn-07', providerId: 'codex', preview: '迁移埋点上报 MCP', count: 24, mtime: NOW - 31 * HOUR, archivedAt: NOW - 30 * HOUR },
  { sessionId: 'rn-08', providerId: 'qoder', preview: '验证a1读取需求图片能力', count: 5, mtime: NOW - 2 * DAY - 2 * HOUR, archivedAt: NOW - 2 * DAY },
  { sessionId: 'rn-09', providerId: 'claude', preview: '准备双需求Workflow重跑环境', count: 18, mtime: NOW - 2 * DAY - 9 * HOUR, archivedAt: NOW - 2 * DAY },
  { sessionId: 'rn-10', providerId: 'codex', preview: '88vip 权益卡片文案回归', count: 3, mtime: NOW - 4 * DAY, archivedAt: NOW - 3 * DAY },

  // scry
  { sessionId: 'sc-01', providerId: 'claude', preview: '设计AI评价折叠沉底标记', count: 33, mtime: NOW - 42 * MINUTE, pinnedAt: NOW - 1 * DAY },
  { sessionId: 'sc-02', providerId: 'codex', preview: '侧边栏置顶与存档方案', count: 8, mtime: NOW - 9 * MINUTE, runId: 'run-sc-02' },
  { sessionId: 'sc-03', providerId: 'opencode', preview: '会话索引降级态文案核对', count: 4, mtime: NOW - 7 * HOUR },
  { sessionId: 'sc-04', providerId: 'claude', preview: '终端 PTY 退出码统计', count: 11, mtime: NOW - 3 * DAY, archivedAt: NOW - 2 * DAY - 4 * HOUR },
  { sessionId: 'sc-05', providerId: 'qoder', preview: '打包后 better-sqlite3 ABI 排查', count: 27, mtime: NOW - 6 * DAY, archivedAt: NOW - 5 * DAY },

  // etch
  { sessionId: 'et-01', providerId: 'codex', preview: 'Run ai-radar scrape', count: 6, mtime: NOW - 4 * HOUR, pinnedAt: NOW - 12 * HOUR },
  { sessionId: 'et-02', providerId: 'claude', preview: '双语硬字幕导出时轴对齐', count: 14, mtime: NOW - 30 * HOUR },
  { sessionId: 'et-03', providerId: 'codex', preview: '压制队列失败重试', count: 2, mtime: NOW - 8 * DAY, archivedAt: NOW - 7 * DAY },

  // 未关联工作目录
  { sessionId: 'un-01', providerId: 'qoder', preview: '整理这周的会话开销', count: 3, mtime: NOW - 11 * HOUR },
  { sessionId: 'un-02', providerId: 'claude', preview: '临时问了个 CSS 问题', count: 1, mtime: NOW - 5 * DAY, archivedAt: NOW - 4 * DAY }
]

const PROJECT_OF = {
  rn: { cwd: '/Users/bao/IdeaProjects/rate-native', name: 'rate-native' },
  sc: { cwd: '/Users/bao/IdeaProjects/vibecoding/scry', name: 'scry' },
  et: { cwd: '/Users/bao/IdeaProjects/vibecoding/etch', name: 'etch' },
  un: { cwd: '', name: 'Chats' }
}

const INITIAL_SESSIONS = SESSIONS.map((s) => ({
  ...s,
  pinnedAt: s.pinnedAt ?? null,
  archivedAt: s.archivedAt ?? null,
  ...PROJECT_OF[s.sessionId.slice(0, 2)]
}))

const PROJECT_ORDER = ['rate-native', 'scry', 'etch', 'Chats']

// 按 cwd 聚合，未关联目录的 Chats 强制排到最后（app-store.ts:324-352 的现有行为）。
function groupByProject(sessions) {
  const byCwd = new Map()
  for (const s of sessions) {
    if (!byCwd.has(s.cwd)) byCwd.set(s.cwd, { cwd: s.cwd, name: s.name, sessions: [] })
    byCwd.get(s.cwd).sessions.push(s)
  }
  const groups = [...byCwd.values()]
  for (const g of groups) g.sessions.sort((a, b) => b.mtime - a.mtime)
  groups.sort((a, b) => {
    if (!a.cwd) return 1
    if (!b.cwd) return -1
    return PROJECT_ORDER.indexOf(a.name) - PROJECT_ORDER.indexOf(b.name)
  })
  return groups
}

function relTime(ms) {
  const diff = Math.max(0, NOW - ms)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  return `${Math.floor(diff / DAY)} 天前`
}

function absTime(ms) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(ms))
}

const PROVIDER_LABEL = { claude: 'claude', codex: 'codex', qoder: 'qoder', opencode: 'opencode' }

Object.assign(window, { INITIAL_SESSIONS, groupByProject, relTime, absTime, PROVIDER_LABEL, NOW })
