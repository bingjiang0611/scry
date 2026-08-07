const scryProviderIds = ['claude', 'codex', 'qoder', 'opencode']

function makeSampleDay(day, totalK, turns, knownTurns, primary = 'claude', secondary = 'codex') {
  if (turns === 0) {
    return {
      day,
      totalK: 0,
      inputK: 0,
      outputK: 0,
      turns: 0,
      knownTurns: 0,
      status: 'zero',
      providers: { claude: 0, codex: 0, qoder: 0, opencode: 0 }
    }
  }

  const providers = { claude: 0, codex: 0, qoder: 0, opencode: 0 }
  const primaryK = Math.round(totalK * 0.68)
  const secondaryK = Math.round(totalK * 0.22)
  const remainder = totalK - primaryK - secondaryK
  providers[primary] += primaryK
  providers[secondary] += secondaryK
  const rest = scryProviderIds.filter((id) => id !== primary && id !== secondary)
  providers[rest[0]] += Math.ceil(remainder / 2)
  providers[rest[1]] += Math.floor(remainder / 2)

  const inputK = Math.round(totalK * 0.84)
  return {
    day,
    totalK,
    inputK,
    outputK: totalK - inputK,
    turns,
    knownTurns,
    status: knownTurns === turns ? 'complete' : 'partial',
    providers
  }
}

const scryAnalyticsDays = [
  makeSampleDay('07-09', 0, 0, 0),
  makeSampleDay('07-10', 86, 1, 1, 'codex', 'claude'),
  makeSampleDay('07-11', 134, 1, 1, 'claude', 'codex'),
  makeSampleDay('07-12', 0, 0, 0),
  makeSampleDay('07-13', 72, 1, 1, 'qoder', 'claude'),
  makeSampleDay('07-14', 148, 1, 1, 'claude', 'qoder'),
  makeSampleDay('07-15', 215, 1, 1, 'codex', 'claude'),
  makeSampleDay('07-16', 96, 1, 1, 'claude', 'opencode'),
  makeSampleDay('07-17', 0, 0, 0),
  makeSampleDay('07-18', 62, 1, 1, 'opencode', 'codex'),
  makeSampleDay('07-19', 187, 1, 1, 'qoder', 'claude'),
  makeSampleDay('07-20', 242, 1, 1, 'claude', 'codex'),
  makeSampleDay('07-21', 119, 1, 1, 'codex', 'qoder'),
  makeSampleDay('07-22', 84, 1, 1, 'qoder', 'claude'),
  makeSampleDay('07-23', 0, 0, 0),
  makeSampleDay('07-24', 158, 1, 1, 'claude', 'codex'),
  makeSampleDay('07-25', 302, 1, 1, 'codex', 'claude'),
  makeSampleDay('07-26', 226, 1, 1, 'claude', 'qoder'),
  makeSampleDay('07-27', 107, 1, 1, 'opencode', 'claude'),
  makeSampleDay('07-28', 64, 1, 1, 'qoder', 'codex'),
  makeSampleDay('07-29', 0, 0, 0),
  makeSampleDay('07-30', 193, 1, 1, 'claude', 'codex'),
  makeSampleDay('07-31', 274, 2, 2, 'codex', 'claude'),
  makeSampleDay('08-01', 316, 3, 3, 'claude', 'codex'),
  makeSampleDay('08-02', 168, 2, 2, 'qoder', 'claude'),
  makeSampleDay('08-03', 0, 0, 0),
  makeSampleDay('08-04', 138, 2, 1, 'qoder', 'claude'),
  makeSampleDay('08-05', 249, 2, 2, 'claude', 'codex'),
  makeSampleDay('08-06', 211, 2, 1, 'codex', 'qoder'),
  makeSampleDay('08-07', 92, 1, 0, 'opencode', 'claude')
]

const scryProviderTokenTotals = Object.fromEntries(
  scryProviderIds.map((providerId) => [
    providerId,
    scryAnalyticsDays.reduce((sum, day) => sum + day.providers[providerId], 0)
  ])
)

const scryRiskEvents = {
  7: { warn: 1, danger: 0, provider: 'claude', reason: '跨项目写入' },
  18: { warn: 1, danger: 0, provider: 'qoder', reason: 'MCP 写入' },
  31: { warn: 0, danger: 1, provider: 'claude', reason: 'git push' },
  44: { warn: 2, danger: 0, provider: 'qoder', reason: '跨项目写入' },
  63: { warn: 1, danger: 0, provider: 'claude', reason: 'MCP 写入' },
  77: { warn: 0, danger: 1, provider: 'qoder', reason: 'sudo 提权' },
  86: { warn: 1, danger: 0, provider: 'claude', reason: '跨项目写入' }
}

const scryRiskStart = Date.UTC(2026, 4, 10)
const scryRiskDays = Array.from({ length: 90 }, (_, index) => {
  const date = new Date(scryRiskStart + index * 86400000)
  const day = `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  return { day, warn: 0, danger: 0, provider: null, reason: '', ...(scryRiskEvents[index] || {}) }
})

const scryAnalyticsSample = {
  meta: {
    snapshot: '2026-08-07',
    sample: true,
    source: '结构仿真 · 不连接 SQLite',
    turns: 31,
    knownTurns: 28,
    toolCalls: 184,
    danger: 2,
    warn: 6
  },
  days: scryAnalyticsDays,
  riskDays: scryRiskDays,
  providers: [
    { id: 'claude', label: 'Claude Code', short: 'CLAUDE', turns: 12, known: 12, tokensK: scryProviderTokenTotals.claude, cache: 0.814, cacheLabel: '可比 12/12', danger: 'classified', dangerLabel: '已分类', risk: '1 danger · 3 warn' },
    { id: 'codex', label: 'Codex', short: 'CODEX', turns: 9, known: 9, tokensK: scryProviderTokenTotals.codex, cache: 0.621, cacheLabel: '可比 9/9', danger: 'unsupported', dangerLabel: '未支持', risk: '不可解释为 0' },
    { id: 'qoder', label: 'Qoder', short: 'QODER', turns: 7, known: 5, tokensK: scryProviderTokenTotals.qoder, cache: null, cacheLabel: '分母未知', danger: 'classified', dangerLabel: '已分类', risk: '1 danger · 3 warn' },
    { id: 'opencode', label: 'OpenCode', short: 'OPENCODE', turns: 3, known: 2, tokensK: scryProviderTokenTotals.opencode, cache: null, cacheLabel: '上游依赖', danger: 'unsupported', dangerLabel: '未支持', risk: '不可解释为 0' }
  ],
  tools: [
    { name: 'Bash', calls: 58, avg: '3.4s', errors: 2, provider: 'claude' },
    { name: 'Read', calls: 44, avg: '0.6s', errors: 0, provider: 'codex' },
    { name: 'Grep', calls: 31, avg: '0.4s', errors: 0, provider: 'qoder' },
    { name: 'Edit', calls: 18, avg: '1.1s', errors: 1, provider: 'codex' },
    { name: 'mcp__browser', calls: 14, avg: '4.8s', errors: 1, provider: 'claude' },
    { name: 'Skill', calls: 9, avg: '0.2s', errors: 0, provider: 'qoder' }
  ],
  latency: [
    { server: 'browser', calls: 18, p50: '1.2s', p95: '4.8s', errors: 1 },
    { server: 'github', calls: 12, p50: '0.8s', p95: '2.4s', errors: 0 },
    { server: 'filesystem', calls: 8, p50: '0.3s', p95: '0.9s', errors: 0 }
  ],
  chapters: [
    { id: 'field', index: '00', short: '30D', label: '近 30 天' },
    { id: 'providers', index: '01', short: 'COVERAGE', label: 'Provider 覆盖' },
    { id: 'operations', index: '02', short: 'ALL', label: '工具与延迟' },
    { id: 'risk', index: '03', short: '90D', label: '风险与盲区' }
  ]
}

Object.assign(window, { scryAnalyticsSample, scryProviderIds })
