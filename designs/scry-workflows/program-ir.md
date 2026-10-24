# WorkflowProgram：可执行数据合同

本文件记录已落地语法，不替代 [M1–M6目标](m1-m6-delivery.md) 或 [完整执行语义](execution-semantics.md)。仍复用唯一 WorkflowProgram/schemaVersion1、修订指纹、审批、Runner 与 outcome/artifact 存储；不另建解释器或把表达式当 JavaScript 执行。

## 按领域查看程序合同

- [动态集合与读取权投影](program-ir-collections.md)
- [持久控制帧、跨进程继续与恢复证据](program-ir-recovery.md)

本页保留模板参数、main 系统步骤、结构输出、表达式及 loop 合同；拆分不增加执行能力。

## 模板实例与声明式参数

- `workflow.instantiateTemplate` 接受准确 saved ref 或 draftId/revision/candidateHash、commandId、已授权 cwd、目标、参数及明确的实际角色绑定。它不调用规划模型，不占 Agent 槽位，不扣尝试预算，也不自动审批或执行。
- 主进程冻结源码引用/字节修订与来源；准确源码在 App-owned 不可变历史中。程序的可选 `template` 字段记录 ref、origin、parameterNames、commandId 和请求指纹，并参与既有 programRevision。模板本身仍不能保存 profile、权限或 runtimeIdentity；实例中的实际角色由当前 catalog 解析并冻结，执行前再核对。
- 参数按名字排序，降低为根 sequence 最前面的普通 `bind`：`{kind:"bind",blockId:name,value:{kind:"literal",value},schema:declaredSchema}`。实际值仅存在这个可执行表示；没有字符串替换、模板全局变量或第二个解释器。未知参数、缺失且无 default、类型不匹配、名称冲突或降低后超过程序原有上限均拒绝。显式 `null/false/0` 不会被 default 覆盖。
- `bind.schema?` 是可选有限数据合同。编译器检查表达式类型可赋值，再以声明 schema 推断后继类型；不能用它做不受检查的强制类型转换。解释器对 known 值重验，失败按 unknown 阻断。省略时保留原来的推断语义。
- 实例创建使用既有根锁的 create-if-absent。重复或竞争 command 返回已冻结的赢家，不覆盖已审批/已执行根；同 command 的不同请求拒绝。Only This Run 使用准确草稿快照而不发布源码。实例在排队、执行及原程序恢复时不重新读取当前模板或草稿；修改、删除和 Git 切换不替换实例。
- 继续原程序仍使用同一 Service/compiler/Interpreter/Runner、原审批、预算及不可变结果；改程序恢复仍未实现。builtin、完整提取合同、Agent 编辑及模板编辑 UI 不因本节而成为已完成。
- 历史 API `templates.history/revision` 只返回本机实际持有的观察/候选快照，不把每个保留修订称为已发布。列表按字节修订哈希排序，每页至多100个引用；不存在的旧源码返回 null，不借当前文件或 Git 推测补齐。
- `templates.restoreDraft({ref,base})` 只创建独立草稿，不改源码。base 必须是审阅的当前 ref，或当前不存在时显式 null；仍须审阅 candidateHash/draftRevision 后走既有 publish。删除后可以恢复同一 templateId；无效历史可恢复成无效可编辑草稿，不能直接发布。
- `templates.delete({ref,commandId})` 只删除匹配准确修订的当前定义，保留历史、草稿和运行。与 publish 共用 canonical 目标锁，先保留准确基线和 intent 再 unlink/fsync。中断后不再次 unlink：有基线快照且观察到不存在时同步目录并以 reconciled_absence 收据确认该后置条件，不归因是谁删除；仍存在或已替换则 unknown。重复完成命令返回历史收据，不能删除后来恢复的定义。真实断电及不合作同用户进程的检查后抢写仍未证明。

## main 工作副本与检查步骤（已接入，非完整质量模式）

- `replica`：`{kind:'replica',blockId,source?:expression}`。省略 source 时复制当前已授权工作区；有 source 时必须是同根 main 铸造的副本值，复制在原副本租约下执行。普通 JSON、路径或 Agent 输出不能铸造该权限。副本值只含 workflowId/replicaId/inputHash；私有目录、inode 与输入清单由 main 登记。
- `check`：`{kind:'check',blockId,replica:expression,check:{argv,cwd,timeoutMs?,parser?}}`。cwd 为副本内相对目录；默认超时 10 分钟，parser 为 exit_code（默认）或 typescript。main 在准备计划时解析并冻结 executable、解释器、环境及适用入口文件的指纹；执行前在真实副本上重验，拒绝变化，不另找解释器。模板只保留请求，禁止携带 authorization；提取时删除该 main 字段，实例化重新冻结与审批。
- 明确的 shell/env 命令入口及内联 runtime 代码不属于检查语法；识别到的 runtime CLI 只支持仓库入口文件（不支持 `-e/-c/-m` 等入口选项），组合命令使用仓库可执行脚本或 package scripts。这不是代码沙箱；仓库脚本及其依赖仍以本机用户权限运行，不能完整枚举所有传递代码。
- argv、目标、相对 cwd、超时与诊断解析器在计划确认界面逐项分页显示；确认整个 programRevision 才授权这些命令。检查使用共享槽位但不计 Agent attempt；每根至多 16,384 个持久系统 intent，不退款、不重放未知效果。stdout/stderr 各至多 1 MiB，超限不能判通过；完整有界文本和诊断保存为 main 不可变 value 引用，不能伪装成 Agent 工具调用。
- check 的数据值包含 passed/state/exitCode/settled/truncated/diagnosticCount。检查退出非零时，步骤可以成功记录一个 `passed:false` 的真实结果；Workflow 执行完成不等于目标通过，质量程序须据该结果分支。无解析器或无法完整识别时 diagnosticCount 为 null，不是 0。程序值另带 diagnostics envelope：available/derived/items（file/line/column/code/message），或 unavailable/reason、无 items；可交给原 field/map/collect 消费。旧的冻结结果允许没有该新增字段，缺失不会补成空集合或触发重跑。还可读取 inputs.before/after/changes：before完整清单须在native前写入原intent，after只在登记scope关闭后采集；available的期间差异含path和added/modified/removed，可经field/concat/map消费。缺失、仍开放或采集/上限失败为unavailable，无items；差异不代表完整审计或某进程独占写入。观察包含原manifest字段，不是原子或可还原的文件版本，仍排除根.git/.scry；具体上限与证据见交付台账。旧冻结值也允许没有inputs，不补证据或重跑。新增 [verification 必需检查汇总与 derived 诊断比较](verification.md) 子集；Jev target、验证范围完整性及可信进展的完整质量编译合同仍未提供。
- `inputs.materialization` 新增 optional 物化关联：`{state,source:'main_ledger',preparationStepId,materialized,candidate?,reason?}`。main 从同根已提交 prepare intent/outcome、不可变结果和副本 receipt.sourceRoot 复核来源，和 before 清单一起先写入 check intent；不是 Agent 自述。materialized 为本次检查副本，其 inputHash 标识**物化时**捕获的输入。candidate 仅在 source 为另一 main 副本时存在，表示来源副本身份；candidate.inputHash 仍是该副本最初创建的 hash，不冒充 Agent 修改后的状态。fork 在来源 lease 内捕获的 hash 才是这个候选版本的输入 hash。
- before.inputHash 等于 materialized.inputHash 时关联 available；物化后副本再修改则为 unavailable/reason，仍可保留本次实际 check pass/fail，但不能归给原候选版本。检查自身写缓存后的 after 差异不反向否定真实 before；关联 available 也不证明检查通过、必需检查完整、候选当前内容或文件系统原子性。历史候选后来修改不触发重检查，旧观察仍指向旧物化版本。读取候选关系可用 `field(ref('verify'),['inputs','materialization','candidate'])`；旧值无字段时不补造、不重跑。JSON 中的 source 标签不铸造副本权限，也不能替代未来质量汇总对原账本及冻结检查合同的验证。
- 根账本保留独立 systemIntents/systemOutcomes；intent 先于副本/进程 effect，结果与不可变值先于控制帧推进。父 checkpoint 失败可以复用已提交结果，不再次复制或启动检查；缺失 stdout/结果/副本收据拒绝复用，不转为重跑。未知组收敛、停止 ACK 或结果写入失败不能释放已启动范围的槽位；重启保留未知系统容量，退出治理也检查系统账本。settled 的当前证明范围是登记的进程组，不是全部逃逸后代或完整沙箱；finishedAt 是 main 收到结果的时间，不冒充物理范围退出时间。
- 副本捕获实际已修改、未跟踪及 ignored 内容，排除根 .git/.scry；内部相对符号链接保留，外链、绝对/悬空链接、嵌套 .git/子模块和特殊文件拒绝。上限为 32,768 项、8 MiB 清单、2 GiB 文件内容；超限拒绝，升级需分页清单/流式归档，不截断输入。部分失败现场保留，不覆盖或自动补做。Manager 的登记与租约原语不等于完整清理 UI/流程。
- `call.replica?:expression`：用同根 main 副本值选择本次 Agent 的工作区；省略仍为原源项目。类型/控制帧依赖和持久 intent 都绑定引用。main 限时内存 grant 与租约经原 App executor 校验源项目授权及副本身份，实际副本运行时目录须保持已冻结 Provider/profile/model/permission/entry 指纹；普通路径/JSON 不能生成 grant。结果 producer 和原 physical scope 同时收敛才撤销 grant/释放租约，停止 ACK 不足。catalog 保留 scoped 来源而不产生全局项目权限，Recorder/trace archive 关联实际副本 cwd。生产离线 App 验证见交付台账；真实 SDK 未验收，副本无 .git 基线，不能外推完整 diff/patch 证据。
- verification 可选冻结 `protectedPaths`，由 main 在同次完整清单校验中证明声明路径的 before/after 端点保持；基线范围变化、缺项、symlink 或超限不放行。这不是测试发现/执行覆盖或全程只读证明，progress 仍 unavailable。完整字段、16 MiB 不同清单预算和验收见 [验证合同](verification.md#声明保护范围与端点证明)。
- **尚未接入**：完整质量模式、可信进展/验证范围完整性证明、组合/应用/完整清理、检查输出查看 API。同根修订恢复仍未实现。本节不代表 M4 或 M1–M6 已完成。

## Agent 调用的结构化输出

`call.outputSchema` 可选。缺省保留原有文本调用；声明后由 main 在接受 Provider result 时验证，不仅靠提示词。合同也参与冻结程序和修订指纹。角色、Provider/profile/模型/权限语义不因数据合同改变。

有限语法：

```json
{
  "kind": "call",
  "blockId": "verify",
  "role": "reviewer",
  "prompt": "Return your evidence-backed verdict",
  "outputSchema": {
    "type": "object",
    "properties": {
      "status": { "type": "enum", "values": ["confirmed", "refuted", "unknown"] },
      "accepted": { "type": "boolean" },
      "reasons": { "type": "array", "items": { "type": "string" }, "maxItems": 64 }
    },
    "required": ["status", "accepted", "reasons"]
  }
}
```

- 标量：`string / number / boolean / null`；number必须有限。枚举只包含不重复的标量。
- union含非空variants；完整值必须符合其中一个合同，不混合不同arm的字段。
- array含items与0–4096的maxItems，省略上限按4096冻结。
- object只允许声明属性，省略required按全部声明字段冻结；显式required可指定可选字段。
- 不支持`$ref`、自定义validator、eval、JS或任意schema扩展；名为command/path的普通数据属性不成为执行权限。
- 最多16层、256个schema节点；schema文本计入原有4MiB程序总文本限制。
- 输出复用原有16,384 UTF-16 code units长度上限。超出必须显式失败，不截断后判成功。大型集合需以有界来源/artifact引用与分批指令承载，不能仅调大输出上限；这些控制与数据分页属于后续M2/M3交付，不据此宣称已完成。

运行时只解析一份完整JSON，不从代码围栏/散文截取片段，不把字符串转数值/布尔，不补缺失字段或默认0/false。合法null/false/0与显式unknown枚举保持原值。无效或缺失输出写为failed outcome，原始有界输出保留供审查，不派发后继，也不退款已派发attempt。数据合同失败不是作用域收敛证明：Provider未settled时，容量仍保留、根保持unknown。

这属于**宿主验证结构化数据**，只证明格式，不证明模型内容属实；独立检查与复核仍必需。不声称Provider原生强制JSON或禁用了工具。高级模板要求的能力仍须另按Provider合同实现/准入，不能靠这条提示词假装具备。

## 有限表达式、绑定与分支

现有Runner新增`bind`与`branch`，不是另一套执行器。`bind`将有限表达式结果单次绑定到blockId；表达式ref使用`{kind:"ref",name:blockId}`。call.inputRefs和return.ref可带JSON字段`path`，不授予文件访问权限。只有已提交前驱可被引用；parallel兄弟与分支私有绑定不可被外部读取。

```json
{
  "kind": "branch",
  "blockId": "decision",
  "when": { "kind": "ref", "name": "verified_boolean" },
  "then": { "kind": "bind", "blockId": "accepted", "value": { "kind": "literal", "value": "accepted report" } },
  "else": { "kind": "bind", "blockId": "rejected", "value": { "kind": "literal", "value": "rejected report" } },
  "unknown": "blocked"
}
```

- branch条件必须为布尔类型；缺字段、缺证据保持unknown，只执行unknown arm或blocked，绝不按false处理。未选arm根节点持久记录`skipped_by_condition`，不创建Agent session或消耗attempt。
- 分支结果为`{arm:"then"|"else"|"unknown",value:...}`标签union。显式unknown arm可产出partial报告；Runner执行完成不等于报告证明任务通过。
- 表达式仅支持literal/ref/field、比较、and/or/not、count/concat、group/unique、filter/partition，不执行JS、回调或任意宿主命令。布尔组合保守传播unknown，不用已知布尔掩盖缺失证据。
- group/unique保留全部members和原始derivedFrom索引，不因键相同丢掉矛盾成员。filter/partition均保留matched/rejected/unknown三组，含index/value/reason及外部判定来源，不返回一个被静默删减的列表。
- 只有own JSON字段可读；数据含constructor等名称不成为原型访问。有限数值、false、0、null保持原值。已封口的空集合有效；缺失来源不是空集合。
- 单表达式深度≤16、指令节点≤256；值≤4MiB UTF-8 JSON、深度≤64、数组≤4096。超过限制整项拒绝，不截尾。动态map及集合引用见下节；streaming group/filter等剩余能力仍待实现；有界loop见下节，不能只提高数据上限绕过。

## 有界 loop、显式 carry 与退出报告

loop仍属于同一WorkflowProgram。`WorkflowLoopExecution`只负责提交循环状态；body回调仍调用唯一Interpreter，Native效果仍走原Runner，不额外向规划模型询问下一步。

冻结字段：

- `initial`与`carry`：同名的`{binding:expression}`字典；`stateSchema`逐项声明有限schema或`inferred`。body内只读本轮状态，只有控制器可在完整验证后提交下一轮。
- `invariants`：非空具名表达式字典，初始化求值一次并持久保存，不能在后续帧改写。外部同名绑定禁止shadow；可显式使用新的合同名称。
- `iteration`可指定只读轮次变量；`best`可标出一个状态引用供观测，**这不是质量证明**。最佳结果是否真的满足约束仍须M4独立评价规则；不能把作者自评分当检查通过。
- `outcome`指定外部可见的宿主退出事实绑定。`result`只读取最后已提交状态/固定合同，向后继提供实际选定结果；不回注body私有上下文。
- `maxIterations`当前必须显式为1–1000。`progress`必须是`bounded_only`，或`{baseline,key,improved}`；后者比较已提交诊断/评价内容的canonical JSON，不比较每轮必变的artifact ID。首次未变化只累加1；连续两轮无进展退出；A→B→A和相邻A→A分开。
- `until`与`improved`必须为布尔类型。缺证据不会变false，不提交未知carry，不把API/格式/权限失败或unknown当作下一逻辑轮的重试。
- `policy`显式声明`{error:"fail_closed",unknown:"block",stop:"cancel",logicalExit:"report_partial"}`。已批准的exhausted/no_progress/oscillation可继续形成partial root报告，但根仍blocked而非completed；这个标记穿过sequence/branch/parallel/map。错误、unknown、停止不因后到success变成功。

控制帧保存initial/current stateRefs、invariantRefs、轮次ready/committed、不可变轮次记录、bestRef、无进展计数、内容历史及全部退出原因。每轮先保存ready状态，body结果与typed carry落盘后再提交committed帧，随后才准入下一轮。提交失败时已完成子调用仍可查，不发新一轮。`iteration`与Native attempt ID独立，预算不重置。主进程重新加载这些引用仍需恢复准入；最初loop阶段未开放恢复API，现有显式继续路径见下节。

15文件187项focused、Node/web types及build通过。关闭连续两轮无进展检查后，1项负对照失败（4次而非2次调用），按SHA256恢复后15项通过。首轮测试真实发现父容器丢失纯控制blocked状态；已在共同执行栈保留非成功状态，不能仅按Native outcome重新算completed。原bare loop测试仍拒绝，只将“未知指令”预期更新为已支持loop缺少明确轮数边界的拒绝。

只读证据：`~/.local/state/rotom/verification-evidence/workflow-m3-loop.xauZEM/`。全部Provider调用仍为test double，不能替代App、真实账号、独立质量检查或M6验收。

当前限制：暂无主进程定时事件截止、带可靠系统比较器的省略轮数模式、完整依赖重启和全指令。受限的跨进程继续已有下述证据，不能外推为每个崩溃边界均已验收。main check及有限汇总已有本节证据；默认质量模板的三轮与可信评价来源仍需M4完整实现；不能由generic until布尔自行认证。
