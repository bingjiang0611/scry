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
- 单表达式深度≤16、指令节点≤256；值≤4MiB UTF-8 JSON、深度≤64、数组≤4096。超过限制整项拒绝，不截尾。集合引用/分页和map/loop等完整控制指令仍待实现，不能只提高上限绕过。

## 控制状态持久化的当前范围

带上述控制/字段投影的程序在原有Runner中写入内容寻址的值artifact与CAS控制帧。帧记录程序修订、作用域、输入来源、分支选择与decision/result引用。值先落盘，再提交引用它的帧；选择帧成功后才派发被选子任务。校验失败、缺artifact、修订/输入不符或已终态帧均拒绝覆盖。unknown帧不可重置为entered/completed。

作用域身份含程序修订及分支选择来源；普通M0程序保留已有任务身份。现有Agent预算/intent与outcome仍由同一Runner提交，不因控制帧退款或重发。

控制求值现已从Runner递归方法迁入唯一`WorkflowInterpreter`：sequence/branch通过显式activation stack求值，parallel各fiber有独立栈，Native调用仍委托原Runner/slots/intent/outcome链。带控制帧的sequence在子结果提交后持久更新cursor和带revision/resultRef的children引用，然后才进入后继；cursor表示已登记子结果数量，不单独授权派发，未知/失败结果仍停止依赖。

测试注入父cursor提交失败后，首个子调用的outcome/终态帧/值仍可由独立store读取，第二个调用不执行。引用读取同时校验frame revision、resultRef和内容hash，不把未完成帧当已提交结果。省略父checkpoint的负对照使3项测试失败。

**这不是M3恢复执行完成**：普通M0程序仍沿用既有任务身份/无控制帧路径；其求值也用显式栈，但本阶段持久cursor只覆盖已有framed程序。跨进程冷恢复、全部指令统一持久化、map迭代、loop carry/最佳候选、恢复调度和sibling复用仍未实现；根的已有观察式历史恢复仍不自动派发。本阶段161项Workflow回归、types/build及负对照日志保存在`~/.local/state/rotom/verification-evidence/workflow-m3-stack.CQmGyT/`，不冒充完整App或真实Provider验收。

## 证据

结构化输出前一阶段：11文件131项Workflow回归、types/build通过；故意关闭输出合同后6项失败。证据范围保留于目标台账。

本阶段命令、源码快照和负对照保留在`~/.local/state/rotom/verification-evidence/workflow-m2-controls.boPZeS/`。生产Runner与真实临时文件存储的合同测试证明选择先持久化、未选arm不执行、unknown不当false、跨store CAS、内容hash及不可覆盖终态。故意将unknown路由为else后两条回归失败（错误completed及额外派发），随后恢复原字节并通过。

首轮测试发现长ID的临时文件名超限，已在原atomic writer修复；首轮typecheck发现测试数据的可选undefined推断，已用准确JSON值类型修正。未扩大超时或删断言。最终检查数与日志见证据目录及台账。

真实App、真实Provider/费用、Provider原生JSON/工具禁用及M2/M3完整控制指令尚未验收。性能命令对providers.catalog返回`No counter collector matches`，不是性能通过；尚无Runner专用计数证据，不作更快声明。
