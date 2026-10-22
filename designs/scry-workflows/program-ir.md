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
- array含items与0–4096的maxItems，省略上限按4096冻结。
- object只允许声明属性，省略required按全部声明字段冻结；显式required可指定可选字段。
- 不支持`$ref`、自定义validator、eval、JS或任意schema扩展；名为command/path的普通数据属性不成为执行权限。
- 最多16层、256个schema节点；schema文本计入原有4MiB程序总文本限制。
- 输出复用原有16,384 UTF-16 code units长度上限。超出必须显式失败，不截断后判成功。大型集合需以有界来源/artifact引用与分批指令承载，不能仅调大输出上限；这些控制与数据分页属于后续M2/M3交付，不据此宣称已完成。

运行时只解析一份完整JSON，不从代码围栏/散文截取片段，不把字符串转数值/布尔，不补缺失字段或默认0/false。合法null/false/0与显式unknown枚举保持原值。无效或缺失输出写为failed outcome，原始有界输出保留供审查，不派发后继，也不退款已派发attempt。数据合同失败不是作用域收敛证明：Provider未settled时，容量仍保留、根保持unknown。

这属于**宿主验证结构化数据**，只证明格式，不证明模型内容属实；独立检查与复核仍必需。不声称Provider原生强制JSON或禁用了工具。高级模板要求的能力仍须另按Provider合同实现/准入，不能靠这条提示词假装具备。

## 证据

相关35条单测、11文件131条Workflow回归、Node/web types及build通过。故意关闭运行时合同检查后6条回归失败，恢复后通过。真实App、真实Provider/费用及M2完整控制指令尚未验收；见目标台账，不将本节当M2完成。
