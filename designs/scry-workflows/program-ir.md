# WorkflowProgram：可执行数据合同

本文件记录已落地语法，不替代 [M1–M6目标](m1-m6-delivery.md) 或 [完整执行语义](execution-semantics.md)。仍复用唯一 WorkflowProgram/schemaVersion1、修订指纹、审批、Runner 与 outcome/artifact 存储；不另建解释器或把表达式当 JavaScript 执行。

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

## 动态 map 与显式 collect

`map`使用`{kind,blockId,items:expression,item:localName,key:[field,...],maxItems,body}`。maxItems省略时为4096；这是冻结、可见的整批拒绝边界，不是截断条数。Native调用的最坏预算为maxItems×body预算；若过于保守，须在确认前声明真实允许的上限，而非运行时少做部分任务。

- 派发前校验完整逻辑集合、唯一有限标量key以及≤4096/已确认maxItems。重复key、超限或未知来源不派发子项；封口的空输入才产生合法空结果。
- 每项执行真实子程序，拥有独立scope和输入指纹；body私有绑定不会逃逸。共享slots/根1000 Agent预算仍由原Runner控制，未创建另一个executor。
- 同时活跃的map fiber有界，任何一项完成即可补位。已测试慢a未完成时，b的verify完成并准入c，不等待整页结束；不是先扫完全部再统一复核。
- 父结果为宿主mint的集合描述符及typed metadata，manifest保留全部key/index/state/settled/result reference。业务unknown和物理settled分开；unknown时停止新项准入，未执行项仍pending，不伪装成功或丢掉。
- manifest为独立、内容寻址的`.collection.json`，受现有8MiB记录限制，不复制每项原始输出；普通数据值仍限4MiB。已验证4096项、超过4MiB的纯引用/状态清单可独立保存并冷读。
- Native JSON schema和literal不能mint集合权限；形似描述符的普通对象不是受控引用。cold load校验manifest存在、hash、workflow、count、slot结构及封口状态。

`collect`使用`{kind:"collect",blockId,items:expression}`，显式读取已封口集合，产生保留全部outcome的有界数组；失败项没有伪造value/0/null，仍有状态和错误。它可紧随其直接依赖的已知、已settled失败map读取摘要；unknown不会因collect推进。执行失败与partial报告可用性分开，不把失败结果改成completed。

map也可读取受控集合：必须沿用`key:["key"]`；只为活跃fiber读取该项payload。需要重分组时先显式collect；collect展开超过4MiB则失败并保留原引用，不声称完整展开。更大的分组/投影需要后续流式引用操作，不能调大普通value上限绕过。

当前限制仍明确保留：嵌套collection存入普通object字段后的typed metadata投影、streaming group/filter、完整依赖恢复尚未完成；不据此宣称全部map/循环/恢复合同通过。嵌套控制树可执行，不代表上述引用投影已经支持。

本阶段14文件172项focused、Node/web types及build通过；关闭重复key预检后1项失败（已发出1次本应禁止的调用），按SHA256恢复后11项通过。首次fixture表参数、误删同内容hash的另一个artifact、回调/联合类型推断失败均保留于证据说明；未删除断言或放宽超时。只读证据：`~/.local/state/rotom/verification-evidence/workflow-m3-map.Yvzbbh/`。这些是生产Runner/临时文件存储加Provider test double，不是完整App或真实账号验收。

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

当前限制：暂无主进程定时事件截止、带可靠系统比较器的省略轮数模式、完整依赖重启、nested collection字段的通用typed投影和全指令。受限的跨进程继续已有下述证据，不能外推为每个崩溃边界均已验收。默认质量模板的三轮、真实main check与可信评价来源还需M4实现；不能由generic until布尔自行认证。

## 控制状态持久化的当前范围

新Runner根执行（包括普通sequence/parallel/call/return）统一写入内容寻址的值artifact与CAS控制帧。帧记录程序修订、作用域、输入来源、分支选择与decision/result引用。值先落盘，再提交引用它的帧；选择帧成功后才派发被选子任务。校验失败、缺artifact、修订/输入不符或已终态帧均拒绝覆盖。unknown帧不可重置为entered/completed。

新运行的作用域身份含程序修订及分支选择来源；无version2执行所有权的旧记录只保留观察路径，不自动升级为可执行运行。现有Agent预算/intent与outcome仍由同一Runner提交，不因控制帧退款或重发。

控制求值现已从Runner递归方法迁入唯一`WorkflowInterpreter`：sequence/branch通过显式activation stack求值，parallel各fiber有独立栈，Native调用仍委托原Runner/slots/intent/outcome链。带控制帧的sequence在子结果提交后持久更新cursor和带revision/resultRef的children引用，然后才进入后继；cursor表示已登记子结果数量，不单独授权派发，未知/失败结果仍停止依赖。

测试注入父cursor提交失败后，首个子调用的outcome/终态帧/值仍可由独立store读取，第二个调用不执行。引用读取同时校验frame revision、resultRef和内容hash，不把未完成帧当已提交结果。省略父checkpoint的负对照使3项测试失败。

最初显式栈阶段的161项回归与限制保留于`~/.local/state/rotom/verification-evidence/workflow-m3-stack.CQmGyT/`；后续普通程序统一持久化与显式继续见下节。**这仍不是M3整体恢复完成**，观察式历史恢复本身始终不派发。

## 显式继续与跨进程恢复的当前范围

`window.scry.workflow.resume(workflowId, approval, commandId)`复用Service、唯一Interpreter/Runner及原App executor链。新根记录带`execution.version:2`、owner与最多256个控制段；命令回执有界且持久，重复命令不重发。完成运行返回`nothing_to_resume`并附原进度；缺失记录返回`{state:"nothing_to_resume",progress:null}`，不合成进度、空根或新执行。已有记录的workspace授权仍来自校验后的冻结程序，不以进度摘要代替。完整依赖恢复及已知失败attempt的明确重试仍待实现。

- 先核对冻结程序、角色/profile/模型/权限、当前runtime能力、原意图/outcome与单调根预算。未知业务结果即使物理settled也拒绝；PID仍存活或无法证明原owner退出则不接管。旧无所有权记录只读。PID复用按仍存活拒绝，不声称识别并接管复用后的进程。
- 接管以根元数据CAS提交新epoch/控制段；旧epoch不能覆盖根、增加预算或再派发。旧终态帧不改写；新帧通过generation与origin关联旧证据。恢复核对分支选择及输入来源，复用有hash校验的原输出和已封口集合引用，不重新调用已完成或已知失败的任务。
- 每个逻辑节点的历史帧读取成本随控制段线性增长，最多256段；若实际量测显示这成为主因，再增加受canonical帧校验的索引，不以索引取代权威记录。loop从持久ready/committed恢复carry、initial/current/best、invariants、迭代记录、内容历史及无进展计数；不把逻辑迭代当transport重试。两个进程间在第二轮ready处退出的场景验证了第二轮消费candidate-1、两轮无进展退出、原seed/best保留及根预算3而非重置。
- 5项独立控制进程场景使用真实本地Node子进程和effect ledger；覆盖子结果完成后硬退出、活owner拒绝、无outcome意图拒绝、loop恢复，以及第二个控制器只写entered帧后再次退出。最近控制帧不覆盖更早已提交结果/loop/decision的证据；三进程回归要求两个已提交依赖调用都复用，零新增效果。macOS用deny-network策略、隔离HOME/工作区；不是文件系统沙箱，也不是账号/模型、真实Provider SDK或完整App的Workflow验收。
- 18文件217项focused在`--maxWorkers=1`通过；其后仅将三进程fixture专注到两个已提交依赖调用（不再附加本已另测的新调用），最终12项恢复回归及types通过。当前App代码的build、conversation IPC、589项CLI release合同及打包安全smoke通过。故意绕过旧效果复用后，用例失败且effect ledger确有两次first；故意只取最近空帧后，已提交依赖链恢复失败。两处均按原SHA恢复；产品源码与通过217项时相同，最终fixture日志另存。初始化存储故障注入随新CAS入口移至claim，同时保留save故障及全部断言。
- 两轮默认并行focused各有1项5秒超时（活owner、loop）；新增三进程用例后，一轮专用串行进程检查也超时1项，日志和失败现场均保留。最终活owner用调用测试的独立进程做拒绝检查，三进程用例要求零新增效果；删除的是重复冷启动/非本场景必需的新调用，不删除owner、依赖链、预算或旧引用断言。10核机器曾记录load38/109/98，后一次约24/20/25，不能据此断言根因。最终12项通过不抹掉这些失败，不提高deadline，不声称默认并行门禁已绿；后续由本任务继续定位争用/收敛。既有7项延期全套失败、Runner性能collector缺口也未关闭。

缺失历史响应后续验证：18文件223项focused串行通过；生产构建的preload/main在独立Electron实例中执行3次缺失历史请求（含同commandId重复），均返回无进度no-op，目录和测试Provider入口账本不变。恢复旧legacy抛错使2项回归失败；错误地采用进度摘要作workspace授权使1项回归失败，之后按SHA恢复产品源码。证据：`~/.local/state/rotom/verification-evidence/workflow-m3-missing-history.ZhQY4H/`。此API局部验收不证明已有运行的完整恢复、真实Provider/SQLite或生产管理UI。

源码与日志：`~/.local/state/rotom/verification-evidence/workflow-m3-recovery.46r4VG/`。产物为未安装的本地Scry0.2.210；打包/通用IPC smoke不代表新的恢复API已在生产Workflow UI、SQLite归档链和每个提交边界端到端验收。

## 证据

结构化输出前一阶段：11文件131项Workflow回归、types/build通过；故意关闭输出合同后6项失败。证据范围保留于目标台账。

本阶段命令、源码快照和负对照保留在`~/.local/state/rotom/verification-evidence/workflow-m2-controls.boPZeS/`。生产Runner与真实临时文件存储的合同测试证明选择先持久化、未选arm不执行、unknown不当false、跨store CAS、内容hash及不可覆盖终态。故意将unknown路由为else后两条回归失败（错误completed及额外派发），随后恢复原字节并通过。

首轮测试发现长ID的临时文件名超限，已在原atomic writer修复；首轮typecheck发现测试数据的可选undefined推断，已用准确JSON值类型修正。未扩大超时或删断言。最终检查数与日志见证据目录及台账。

真实App、真实Provider/费用、Provider原生JSON/工具禁用及M2/M3完整控制指令尚未验收。性能命令对providers.catalog返回`No counter collector matches`，不是性能通过；尚无Runner专用计数证据，不作更快声明。
