import type { WorkspaceDiffResult } from '../trace'

type WorkspaceDiffState = WorkspaceDiffResult | null | undefined

function label(result: WorkspaceDiffState): string {
  if (result === undefined) return '尚未采集'
  if (result === null) return '采集中'
  switch (result.status) {
    case 'captured': return '无改动'
    case 'unavailable': return '不可用'
    case 'timeout': return '采集超时'
    case 'failed': return '采集失败'
  }
}

function detail(result: WorkspaceDiffState): string {
  if (!result) return label(result)
  if (result.status === 'captured') return result.files.length ? count(result.files.length) : label(result)
  const reasons: Record<Exclude<WorkspaceDiffResult, { status: 'captured' }>['reason'], string> = {
    not_git: '当前目录不是 Git 工作树',
    no_head: '仓库尚无 HEAD，无法比较改动',
    deadline: 'Git 采集超时',
    git_error: 'Git 采集失败',
    no_baseline: '缺少 Git 比较基线',
    request_failed: '无法读取工作区改动'
  }
  return reasons[result.reason]
}

const count = (value: number): string => `${value} 个工作区文件的 Git 净改动`

export const workflowControlCopy = {
  stopLimit: '工作流停止命令已达上限；请检查未收敛作用域，不会重发或清空收据',
  invalidStopReceipt: '工作流停止收据合同无效',
  unconfirmedStopReceipt: '停止请求尚未确认持久化，不会重发；修复存储后请再次停止',
  invalidPlanningStopReceipt: '工作流规划停止收据合同无效'
}

export const workflowValueCopy = {
  programLimit: '工作流程序文本超过 4 MiB 上限',
  invalidSchema: '工作流结构化输出合同无效',
  bindingContract: '工作流绑定值不符合声明的数据合同',
  schemaLimit: '工作流数据合同超过深度或节点上限',
  unsupportedField: (field: string) => `工作流数据合同字段不受支持：${field}`,
  invalidRequired: '工作流必需字段必须存在于属性声明中且不能重复',
  invalidArrayLimit: '工作流数组上限必须为 0–4096 的整数',
  invalidEnum: '工作流枚举必须包含有限、不重复的标量值',
  invalidOutput: 'Agent 未返回合同要求的完整 JSON 输出',
  outputLimit: 'Agent 输出超过工作流 16384 字符上限',
  valueMismatch: (path: string, expected: string) => `工作流输出 ${path} 不符合 ${expected} 合同`,
  unexpectedProperty: (path: string) => `工作流输出包含未声明字段：${path}`,
  missingProperty: (path: string) => `工作流输出缺少必需字段：${path}`,
  structuredInstruction: 'Return only one complete JSON value matching this frozen data contract. Do not wrap it in Markdown or add commentary. Missing evidence must not be invented or replaced by zero/false. Contract:'
}

export const workflowExpressionCopy = {
  invalid: '工作流表达式无效',
  limit: '工作流表达式超过深度或节点上限',
  valueLimit: '工作流数据超过大小、深度或集合上限，未继续执行',
  field: (field: string) => `工作流表达式字段不受支持：${field}`,
  reference: (name: string) => `工作流绑定不可用：${name}`,
  role: (role: string) => `程序引用了未配置角色：${role}`,
  missing: (path: string) => `工作流值缺少字段：${path}`,
  type: (kind: string) => `工作流表达式类型不匹配：${kind}`,
  key: '工作流集合键必须是有限标量',
  binding: (name: string) => `工作流绑定已存在：${name}`,
  trueReason: 'condition_true',
  falseReason: 'condition_false'
}

export const workspaceAuthorizationCopy = {
  invalid: '无效的工作目录',
  directory: '工作目录不存在或不是文件夹',
  unselected: '工作目录尚未通过 Scry 目录选择器授权'
} as const

export const appStorePersistenceCopy = {
  schema: 'JSON schema mismatch',
  primaryMissing: '主索引缺失，已使用备份',
  primaryInvalid: (error: string | undefined) => `主索引损坏，已使用备份：${error}`,
  unavailable: (primary: string, backup: string) => `主索引与备份均不可用：${primary}；${backup}`
} as const

export const workflowTemplateCopy = {
  sourceChanged: '模板来源或修订已变化，请刷新并重新确认',
  instanceCommand: '模板实例化 commandId 已用于另一请求',
  historyMissing: '此修订没有保留的源码，无法恢复',
  deleteCommand: '删除 commandId 已用于另一请求',
  deletePending: '删除收据未完成，当前内容不能证明结果；未自动重删',
  fixtureModel: '隔离工作流测试模型',
  workspace: '工作流工作区与当前授权目录不一致',
  frozen: '模板冻结快照缺失或与程序不一致，不能执行',
  instantiationUnavailable: '当前工作流服务未提供模板实例化',
  parameterValue: (name: string) => `模板参数缺失或不符合数据合同：${name}`,
  roleBindings: '实际角色绑定必须与模板声明一致；不会自动使用其他 Provider 或配置档',
  invalid: '工作流模板定义或请求无效',
  version: '工作流模板版本不受支持',
  limit: '单个模板或草稿内容不能超过 4 MiB',
  path: '模板目录或文件不是获授权范围内的普通目标，拒绝链接写入或读取',
  missing: '工作流模板或草稿不存在',
  staleDraft: '草稿已变化，请重新读取并核对差异',
  invalidDraft: '草稿尚未通过定义校验，不能发布',
  command: '模板 commandId 已用于另一操作',
  ledger: '模板快照或操作收据校验失败',
  pending: '发布收据未完成，当前内容不能证明结果；未自动重写',
  parameter: '模板参数缺失、类型不符或包含未声明参数'
}

export const workflowRecoveryCopy = {
  legacy: '此运行没有完整的恢复合同，只能查看历史，不会重新派发',
  unknown: '原调用结果或作用域仍未知，不能恢复派发',
  owner: '原控制器仍在运行或身份无法证明已关闭，未接管执行',
  stale: '执行控制段已变化，旧控制器不能覆盖或继续派发',
  ledger: '工作流恢复账本、预算或身份不一致',
  fingerprint: '冻结程序已变化，不能按原运行恢复',
  limit: '工作流恢复控制段已达 256 次上限',
  frame: '恢复所需的输入或控制帧证据缺失或不一致',
  output: '恢复所需的不可变输出缺失或校验失败'
}

export const workflowLoopCopy = {
  bounds: '循环轮数必须是已确认的 1–1000 整数',
  contract: '循环必须声明固定合同、状态、carry、进展与退出策略',
  bindings: '循环绑定名称或状态字段集合无效',
  schema: '循环状态不符合冻结类型合同',
  policy: '循环必须明确以下策略：错误 fail_closed、unknown block、停止 cancel、逻辑退出 report_partial',
  condition: '循环成功和进展条件必须为布尔类型',
  progress: '循环进展键必须是已提交的诊断或评价内容，不能直接比较集合引用',
  unknown: '循环关键证据未知，未提交下一轮状态',
  checkpoint: '循环控制帧不允许回退轮次或改写固定合同'
}

export const workflowCollectionCopy = {
  invalid: '工作流集合引用或清单无效',
  unsealed: '工作流集合来源尚未封口，未继续执行',
  key: '工作流集合 key 必须是唯一的有限标量',
  limit: '工作流集合超过已确认的批次上限，未派发任何子项',
  payloadLimit: '集合展开结果超过 4 MiB 上限；原始子结果引用已保留',
  budget: '工作流最坏调用预算超出整数范围，请降低已确认批次上限',
  source: '工作流 map 来源必须是已提交数组或受控集合引用',
  collectionKey: '受控集合 map 必须沿用 key 字段；重分组前需显式 collect',
  pending: '子项尚未执行或没有完整结果'
}

export const workflowFrameCopy = {
  unsupportedBlock: '仅支持已实现的 sequence、parallel、call、bind、branch、map、collect、loop、return；其他控制块暂不可用',
  invalid: '工作流控制帧合同无效',
  revision: '工作流控制帧修订已变化，不能覆盖',
  identity: '工作流控制帧输入或身份已变化，不能复用旧状态',
  terminal: '工作流已提交控制帧不可改写',
  decision: '工作流已冻结分支选择不可改写',
  reference: '工作流值引用身份无效',
  digest: '工作流值引用内容校验失败',
  missing: '工作流已引用的控制状态或值缺失',
  branchUnknown: '分支条件证据未知，未选择 true/false 分支',
  expectedBoolean: '工作流分支条件必须为布尔类型',
  unknownArm: '工作流分支必须声明 unknown 分支或 blocked',
  failedValue: '工作流前驱没有可用的已提交输出'
}

export const workflowShutdownCopy = {
  title: 'Scry',
  unconfirmed: '工作流尚未全部收敛，已阻止安全退出；请检查工作流状态并再次停止。',
  storageFailure: '工作流停止意图未能确认持久化，已阻止安全退出；不会重发未知控制命令。',
  initializationFailure: '工作流历史初始化失败，无法确认工作流状态，已阻止安全退出。',
  admissionClosed: '工作流服务正在退出',
  admissionGenerationChanged: '工作流退出准备已开始',
  planningCancelled: '工作流规划已取消',
  planningJournalUnavailable: (id: string) => `工作流规划停止意图无法定位：${id}`,
  recoveredScopeUnavailable: '恢复的工作流作用域没有可用控制，不能证明安全退出',
  convergenceTimeout: '工作流在安全退出期限内未完成有证据的收敛',
  preparationTimeout: '工作流安全退出准备期限已到；未完成的存储或初始化工作仍保持冻结',
  planningJournalMissing: (id: string) => `工作流规划记录缺失：${id}`,
  planningStopIdentityConflict: (id: string) => `工作流规划停止身份冲突：${id}`,
  detail: (ids: readonly string[]) => ids.length ? `未收敛工作流：${ids.join('、')}` : '未收敛工作流状态未知'
}

export const workspaceDiffCopy = {
  invalidDirectory: '无效的工作目录',
  heading: 'Changes',
  overviewHeading: '工作区未提交改动（vs HEAD）',
  binary: 'binary',
  scope: '当前工作树对比 HEAD（含未跟踪新文件，不含 ignored）· 含本会话之外的改动 · check=结构化文件工具足迹内 · alert=未被结构化文件工具记录',
  label,
  detail,
  count,
  totals: (count: number, added: number, deleted: number) => `${count} files · +${added} −${deleted}`,
  report: (result: WorkspaceDiffState, untouched: number): string => {
    if (!result || result.status !== 'captured') return `- **git diff**：${detail(result)}`
    if (!result.files.length) return '- **git diff**：无改动'
    return `- **git diff**：${result.files.length} 文件${untouched ? `（${untouched} 未经工具标记）` : ''}`
  }
}
