// Rendering of the generated IPC routing documents (daemon-ipc-matrix.mjs builds the
// matrix, this turns it into the files). Split out so neither file passes 20 KB.

// The workbench surfaces: device forwards, and the App terminal op that replaced the
// terminal forwards (P3-terminal.md). Kept apart so each generated file stays small.
const isWorkbenchRow = (row) => row.target.startsWith('desktopWorkbench:') || row.target.startsWith('terminal:')
// Unified conversation channels have their own file, so each generated file stays under
// the 20 KB pre-commit limit.
const isConversationRow = (row) => !isWorkbenchRow(row) && row.channel.startsWith('conversation:')
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
    `- 统一对话（\`conversation:*\`，共 ${rows.filter(isConversationRow).length} 行）见 [P3-ipc-matrix-conversation](P3-ipc-matrix-conversation.md)`,
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
  for (const row of rows) if (!isWorkbenchRow(row) && !isConversationRow(row)) lines.push(matrixRow(row))
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

export function renderConversationMatrix({ rows }) {
  const lines = [
    '# P3 附录 · IPC 路由矩阵：统一对话（生成文件）',
    '',
    '本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing.json` 后重新生成。判定规则与其余 channel 见 [P3-ipc-matrix](P3-ipc-matrix.md)。',
    '',
    ...MATRIX_HEADER
  ]
  for (const row of rows) if (isConversationRow(row)) lines.push(matrixRow(row))
  return `${lines.join('\n')}\n`
}

export function renderOps({ rows }, routing) {
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
