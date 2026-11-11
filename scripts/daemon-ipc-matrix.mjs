#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The IPC routing matrix answers one question per privileged channel: when the daemon
// owns the run pipeline, does this call stay in main, travel over an existing protocol
// op, or need a new one? It is generated from the source of truth (the handleTrusted
// registrations and the dispatch vocabulary) so a new channel cannot be added without a
// decision, and a rename cannot drift away from the recorded op/method.
const root = fileURLToPath(new URL('..', import.meta.url))
export const MATRIX_DOC = join(root, 'docs/plans/remote-runtime-v2/P3-ipc-matrix.md')
export const WORKBENCH_MATRIX_DOC = join(root, 'docs/plans/remote-runtime-v2/P3-ipc-matrix-workbench.md')
const ROUTING = join(root, 'scripts/daemon-ipc-routing.json')
const ROUTING_WORKBENCH = join(root, 'scripts/daemon-ipc-routing-workbench.json')
const ROUTING_CLIENT = join(root, 'scripts/daemon-ipc-routing-client.json')
const OPS = join(root, 'scripts/daemon-ipc-ops.json')
const DIFFERENCES = join(root, 'scripts/daemon-ipc-differences.json')
const APPROVALS = join(root, 'scripts/daemon-ipc-remote-approvals.json')
const PATHS = join(root, 'scripts/performance-paths.json')
const MAIN_DIR = join(root, 'src/main')
const DISPATCH = ['src/main/remote/inner-mtls-dispatch.ts', 'src/main/remote/inner-mtls-history-dispatch.ts']
const WORKBENCH = 'src/shared/desktop-workbench.ts'
const ROUTES = new Set(['main', 'forward', 'new-op', 'split'])

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

/** Every privileged channel in production source, with the file that registers it. */
// Registrations whose channel is built from a handler table, e.g. `sourceControl:${method}`.
// Each prefix names how to read its method list from source; an unknown templated
// registration fails the scan instead of silently dropping channels.
const TEMPLATED = {
  sourceControl: () => {
    const source = readFileSync(join(root, 'src/main/source-control/ipc.ts'), 'utf8')
    const start = source.indexOf('export function sourceControlHandlers')
    const body = source.slice(start, source.indexOf('satisfies Record', start))
    const methods = [...body.matchAll(/^\s{4}(\w+):/gm)].map(([, name]) => name)
    if (start < 0 || methods.length === 0) throw new Error('cannot read sourceControlHandlers')
    return methods
  },
  // The App's client to other hosts (remote/desktop-client-ipc.ts) enumerates its methods.
  desktopRemote: () => {
    const source = readFileSync(join(root, 'src/main/remote/desktop-client-ipc.ts'), 'utf8')
    const start = source.indexOf('export const DESKTOP_REMOTE_CLIENT_METHODS = [')
    const body = source.slice(start, source.indexOf('] as const', start))
    const methods = [...body.matchAll(/'([a-zA-Z]+)'/g)].map(([, name]) => name)
    if (start < 0 || methods.length === 0) throw new Error('cannot read DESKTOP_REMOTE_CLIENT_METHODS')
    return methods
  }
}

export function collectChannels(dir = MAIN_DIR) {
  const found = new Map()
  const add = (channel, file) => {
    if (found.has(channel)) throw new Error(`duplicate registration: ${channel} in ${relative(root, file)} and ${relative(root, found.get(channel))}`)
    found.set(channel, file)
  }
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    // `handle(`, `register(` and `registerTrusted(` are the parameter names the per-area
    // registrars (workspace selection, git diff, desktop client) give the same trusted
    // registrar; every spelling reaches registerTrustedIpcHandler.
    for (const match of source.matchAll(/\b(?:handleTrusted|handle|register|registerTrusted)\(\s*'([a-zA-Z0-9:_-]+)'/g)) add(match[1], file)
    // Handler tables shared by main and the daemon (bootstrap/startup-channels.ts): each
    // `return { 'channel': … } satisfies ChannelHandlers` is registered through
    // registerChannelHandlers, so its keys are production channels.
    for (const table of source.matchAll(/return \{([\s\S]*?)\} satisfies ChannelHandlers/g)) {
      for (const key of table[1].matchAll(/^\s+'([a-zA-Z]+:[a-zA-Z:]+)':/gm)) add(key[1], file)
    }
    for (const match of source.matchAll(/\b(?:handleTrusted|handle|register|registerTrusted)\(\s*`([a-zA-Z]+):\$\{\w+\}`/g)) {
      const expand = TEMPLATED[match[1]]
      if (!expand) throw new Error(`templated registration ${match[1]}:\${...} in ${relative(root, file)} has no expander`)
      for (const method of expand()) add(`${match[1]}:${method}`, file)
    }
  }
  return [...found.entries()].map(([channel, file]) => ({ channel, file: relative(root, file) })).sort((a, b) => a.channel.localeCompare(b.channel))
}

const PRELOAD_DIR = join(root, 'src/preload')

/**
 * Every channel the preload invokes. The registration scan reads several spellings; this
 * independent list catches a spelling it does not know yet, which would otherwise leave
 * a channel without a decision and refused by the daemon gate.
 */
export function preloadChannels(dir = PRELOAD_DIR) {
  const channels = new Set()
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    if (/invoke\(\s*`/.test(source)) throw new Error(`templated invoke in ${relative(root, file)}: list preload channels literally`)
    for (const match of source.matchAll(/\binvoke\(\s*'([a-zA-Z0-9:_-]+)'/g)) channels.add(match[1])
  }
  return channels
}

/** The device-facing op vocabulary, read from the dispatch chain that serves it. */
export function protocolOps() {
  const ops = new Set()
  for (const file of DISPATCH) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/request\.op === '([a-zA-Z0-9]+)'/g)) ops.add(match[1])
  }
  return ops
}

export function workbenchMethods() {
  const source = readFileSync(join(root, WORKBENCH), 'utf8')
  const block = source.slice(source.indexOf('DESKTOP_WORKBENCH_METHODS = {'))
  const body = block.slice(0, block.indexOf('} as const'))
  const surfaces = new Map()
  for (const match of body.matchAll(/^\s{2}([a-zA-Z]+):\s*\[([^\]]*)\]/gm)) {
    surfaces.set(match[1], new Set([...match[2].matchAll(/'([a-zA-Z]+)'/g)].map(([, name]) => name)))
  }
  if (surfaces.size === 0) throw new Error('cannot read DESKTOP_WORKBENCH_METHODS')
  return surfaces
}

export function performancePaths() {
  return new Set(JSON.parse(readFileSync(PATHS, 'utf8')).paths.map((path) => path.id))
}

/**
 * Hand-maintained inputs, split by responsibility: which channel goes where, what each
 * new op looks like, how each forwarded op differs from the device protocol, and which
 * new ops a remote device may reach. Each file stays under the staged size budget.
 */
export function loadRouting(routingPath = ROUTING, opsPath = OPS, differencesPath = DIFFERENCES, approvalsPath = APPROVALS, workbenchPath = ROUTING_WORKBENCH, clientPath = ROUTING_CLIENT) {
  const routing = JSON.parse(readFileSync(routingPath, 'utf8'))
  const workbench = JSON.parse(readFileSync(workbenchPath, 'utf8'))
  const client = JSON.parse(readFileSync(clientPath, 'utf8'))
  const ops = JSON.parse(readFileSync(opsPath, 'utf8'))
  const differences = JSON.parse(readFileSync(differencesPath, 'utf8'))
  const approvals = JSON.parse(readFileSync(approvalsPath, 'utf8'))
  for (const [name, data] of [['routing', routing], ['workbench routing', workbench], ['client routing', client], ['ops', ops], ['differences', differences], ['approvals', approvals]]) {
    if (data.schema !== 1) throw new Error(`${name} schema must be 1`)
  }
  if (!Array.isArray(routing.channels) || !Array.isArray(workbench.channels) || !Array.isArray(client.channels) || !ops.ops || !differences.differences || !Array.isArray(approvals.approved)) {
    throw new Error('routing inputs are incomplete')
  }
  return { schema: 1, channels: [...routing.channels, ...workbench.channels, ...client.channels], ops: ops.ops, differences: differences.differences, approved: new Set(approvals.approved) }
}

/**
 * Join source channels with the recorded decision. Returns rows plus every defect, so
 * the generator and its test report the same reasons instead of throwing on row one.
 */
export function buildMatrix(routing = loadRouting(), dir = MAIN_DIR, invoked = dir === MAIN_DIR ? preloadChannels() : new Set()) {
  const channels = collectChannels(dir)
  const ops = protocolOps()
  const surfaces = workbenchMethods()
  const paths = performancePaths()
  const defects = []
  const rows = []
  const opMethods = new Map()
  const recorded = new Map()
  for (const row of routing.channels) {
    if (recorded.has(row.channel)) defects.push({ channel: row.channel, problem: 'recorded twice' })
    recorded.set(row.channel, row)
  }
  for (const { channel, file } of channels) {
    const row = recorded.get(channel)
    if (!row) { defects.push({ channel, problem: `no routing decision (registered in ${file})` }); continue }
    recorded.delete(channel)
    const suffix = channel.slice(channel.lastIndexOf(':') + 1)
    if (!ROUTES.has(row.route)) { defects.push({ channel, problem: `unknown route ${JSON.stringify(row.route)}` }); continue }
    const op = routing.ops[row.op]
    const path = row.path ?? op?.path
    if (row.route === 'main') {
      if (!row.why) defects.push({ channel, problem: 'main route needs a reason' })
    } else if (row.route === 'forward') {
      if (!ops.has(row.op)) defects.push({ channel, problem: `forward op ${JSON.stringify(row.op)} is not in the dispatch vocabulary` })
      if (row.surface !== undefined) {
        const methods = surfaces.get(row.surface)
        if (!methods?.has(row.method)) defects.push({ channel, problem: `workbench method ${row.surface}.${row.method} does not exist` })
      }
      if (!row.why) defects.push({ channel, problem: 'forward route needs a reason' })
      if (!routing.differences[channel]) defects.push({ channel, problem: 'forward route must record its semantic difference from the device protocol' })
    } else if (row.route === 'split') {
      // Some work is window-bound (a native picker), the rest writes daemon-owned state.
      // Recording both halves keeps "main still owns it" from hiding a second writer.
      if (!row.main) defects.push({ channel, problem: 'split route must say what stays in main' })
      if (!op) defects.push({ channel, problem: `split op ${JSON.stringify(row.op)} is not defined in the ops file` })
      if (row.method !== suffix) defects.push({ channel, problem: `split method ${JSON.stringify(row.method)} must equal the channel's last segment ${JSON.stringify(suffix)}` })
      if (!paths.has(path)) defects.push({ channel, problem: `unknown user path ${JSON.stringify(path)}` })
    } else {
      if (!op) defects.push({ channel, problem: `new-op ${JSON.stringify(row.op)} is not defined in the ops file` })
      else {
        for (const field of ['request', 'response', 'authorize']) if (!op[field]) defects.push({ channel, problem: `new-op ${row.op} is missing ${field}` })
        if (!Array.isArray(op.scopes) || op.scopes.length === 0) defects.push({ channel, problem: `new-op ${row.op} must declare scopes` })
        else if (op.scopes.includes('remote') && !routing.approved.has(row.op)) {
          defects.push({ channel, problem: `new-op ${row.op} opens to remote devices without maintainer approval` })
        }
      }
      if (row.method !== suffix) defects.push({ channel, problem: `method ${JSON.stringify(row.method)} must equal the channel's last segment ${JSON.stringify(suffix)}` })
      const key = `${row.op}:${row.method}`
      if (opMethods.has(key)) defects.push({ channel, problem: `op method ${key} is already claimed by ${opMethods.get(key)}` })
      opMethods.set(key, channel)
      if (!paths.has(path)) defects.push({ channel, problem: `unknown user path ${JSON.stringify(path)}` })
    }
    rows.push({
      channel,
      route: row.route,
      target: row.route === 'main' ? '—'
        : row.route === 'forward' ? (row.surface ? `${row.op}:${row.method}` : row.op)
          : `${row.op}:${row.method}`,
      path: row.route === 'new-op' || row.route === 'split' ? path : '—',
      note: row.route === 'forward' ? routing.differences[channel]
        : row.route === 'split' ? `main: ${row.main}`
          : row.source ?? '—',
      why: row.why ?? op?.why ?? ''
    })
  }
  for (const row of Object.keys(routing.differences)) {
    if (!channels.some((entry) => entry.channel === row)) defects.push({ channel: row, problem: 'difference recorded for a channel that is not forwarded' })
  }
  for (const row of recorded.values()) defects.push({ channel: row.channel, problem: 'routed but no longer registered in src/main' })
  const registered = new Set(channels.map((entry) => entry.channel))
  for (const channel of invoked) {
    if (!registered.has(channel)) defects.push({ channel, problem: 'invoked by the preload but the registration scan did not find it' })
  }
  return { rows, defects, channels: channels.length }
}

export const OPS_DOC = join(root, 'docs/plans/remote-runtime-v2/P3-ipc-ops.md')

// The workbench surfaces: device forwards, and the App terminal op that replaced the
// terminal forwards (P3-terminal.md). Kept apart so each generated file stays small.
const isWorkbenchRow = (row) => row.target.startsWith('desktopWorkbench:') || row.target.startsWith('terminal:')
const matrixRow = (row) => `| \`${row.channel}\` | ${row.route} | \`${row.target}\` | ${row.path} | ${row.note} | ${row.why} |`
const MATRIX_HEADER = ['| channel | 去向 | op(method) | 用户路径 | 差异与分工 | 依据 |', '|---|---|---|---|---|---|']

export function renderMatrix({ rows, defects, channels }) {
  const count = (route) => rows.filter((row) => row.route === route).length
  const lines = [
    '# P3 附录 · IPC channel 路由矩阵（生成文件）',
    '',
    '本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing.json` 后重新生成。',
    '',
    `- 生产特权 IPC channel：${channels} 个（\`src/main/**\` 经 \`handleTrusted\` 注册，不含测试；含 \`handle(\` 参数名与 \`sourceControl:\${method}\` 这类按表展开的注册）`,
    `- 留在 main：${count('main')}，一半 main 一半 daemon（\`split\`）：${count('split')}，转发到现有 op：${count('forward')}，需要新增 op：${count('new-op')}`,
    '- 新增 op 的请求、响应、授权与调用方范围见 [P3-ipc-ops](P3-ipc-ops.md)；设计正文见 [P3 §13](P3-batch4-design.md)',
    `- 工作台行（\`desktopWorkbench\` 转发的 workspace / sourceControl，与 App 终端 op \`terminal\`，共 ${rows.filter(isWorkbenchRow).length} 行）见 [P3-ipc-matrix-workbench](P3-ipc-matrix-workbench.md)`,
    '',
    '## 判定规则',
    '',
    '| 去向 | 含义 |',
    '|---|---|',
    '| `main` | 窗口、菜单、原生对话框、剪贴板、本机只读文件引用，以及连接别的宿主的 `DesktopRemoteClient`。 |',
    '| `forward` | 能力已在 daemon 里且有现成协议 op；迁移只做转发与 envelope 转换。 |',
    '| `new-op` | 能力在 daemon 侧已存在或必须存在，但设备协议里还没有对应 op。 |',
    '| `split` | 一半留 main 一半走 daemon：原生选择框之类只能窗口做，但落盘的是 daemon 的授权输入，必须由 daemon 写。 |',
    '',
    '`forward` 沿用该 op 现有鉴权（已验证 peer + 该 op 自己的 payload/cwd 校验），但语义不一定等价，逐行见「差异与分工」。`new-op` 与 `split` 的 op 按 [P3-ipc-ops](P3-ipc-ops.md) 实现，调用方范围由 `scopes` 决定（默认只有 `local`）。都不因「本机」放宽。',
    '',
    '## 矩阵',
    '',
    '「差异与分工」列：`forward` 行写与设备协议的语义差异（等价也要写），`split` 行写 main 侧做什么，`main` 行写它依赖的 daemon 数据来源。',
    '',
    ...MATRIX_HEADER
  ]
  for (const row of rows) if (!isWorkbenchRow(row)) lines.push(matrixRow(row))
  if (defects.length > 0) {
    lines.push('', '## 未分类', '')
    for (const defect of defects) lines.push(`- \`${defect.channel}\`：${defect.problem}`)
  }
  return `${lines.join('\n')}\n`
}

export function renderWorkbenchMatrix({ rows }) {
  const lines = [
    '# P3 附录 · IPC 路由矩阵：工作台（生成文件）',
    '',
    '本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing-workbench.json` 后重新生成。判定规则与其余 channel 见 [P3-ipc-matrix](P3-ipc-matrix.md)。',
    '',
    ...MATRIX_HEADER
  ]
  for (const row of rows) if (isWorkbenchRow(row)) lines.push(matrixRow(row))
  return `${lines.join('\n')}\n`
}

export function renderOps({ rows }, routing = loadRouting()) {
  const used = new Set(rows.filter((row) => row.route === 'new-op' || row.route === 'split').map((row) => row.target.slice(0, row.target.lastIndexOf(':'))))
  const lines = [
    '# P3 附录 · 新增协议 op（生成文件）',
    '',
    '本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑。',
    '',
    `列出 [IPC 矩阵](P3-ipc-matrix.md) 判为 \`new-op\` 或 \`split\` 的 op。每个 op 用 \`method\` 区分通道（method 等于 channel 最后一段），与 \`desktopWorkbench\` 的 surface/method 约定一致：一个授权边界一个 op，不为每个 channel 造一个顶层 op。`,
    '',
    '`scopes` 是允许调用该 op 的调用方范围：`local` = 本机 App（unix socket + `scope: local` grant），`remote` = 已配对设备。默认只有 `local`；任何新增 `remote` 都要先写进 `scripts/daemon-ipc-remote-approvals.json`，那属于授权扩大，需维护者批准。',
    '',
    '| op | 调用方 | 用户路径 | 请求 | 响应 | 授权 |',
    '|---|---|---|---|---|---|'
  ]
  for (const [name, op] of Object.entries(routing.ops)) {
    if (used.has(name)) lines.push(`| \`${name}\` | ${op.scopes.join(', ')} | ${op.path} | ${op.request} | ${op.response} | ${op.authorize} |`)
  }
  return `${lines.join('\n')}\n`
}

const DOCS = [
  [MATRIX_DOC, renderMatrix],
  [WORKBENCH_MATRIX_DOC, renderWorkbenchMatrix],
  [OPS_DOC, renderOps]
]

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const matrix = buildMatrix()
  if (process.argv.includes('--write')) {
    for (const [path, render] of DOCS) {
      writeFileSync(path, render(matrix))
      console.log(`wrote ${relative(root, path)}`)
    }
  } else {
    for (const [path, render] of DOCS) {
      if (readFileSync(path, 'utf8') !== render(matrix)) {
        console.error(`${relative(root, path)} is stale: run node scripts/daemon-ipc-matrix.mjs --write`)
        process.exitCode = 1
      }
    }
    if (!process.exitCode) console.log(`IPC matrix up to date (${matrix.channels} channels)`)
  }
  for (const defect of matrix.defects) console.error(`  ${defect.channel}: ${defect.problem}`)
  if (matrix.defects.length > 0) process.exitCode = 1
}
