# 必需检查集合与诊断比较（M4 子集）

本增量沿用 Program → Service → canonical Runner → Interpreter → main SystemHost。不是另一个质量调度器，不执行生成的 JS/shell。M4、可信进展及整体 M1–M6 仍未完成。

## 冻结程序合同

```ts
{
  kind: 'verification', blockId: 'current',
  required: {
    types: { check: 'current_types', result: { kind: 'ref', name: 'current_types' } },
    tests: { check: 'current_tests', result: { kind: 'ref', name: 'current_tests' } }
  },
  baseline: { kind: 'ref', name: 'baseline_verification' } // optional
}
```

- required 是1–64个具名要求；key、check 均为原有限 ID。每个 check 必须指向同一冻结程序中真实的 check block，不得用 Agent 的布尔评价代替。未知字段、空集合、超限、非 check 目标、未支配的 result/baseline 引用均编译拒绝。
- result/baseline 经原表达式系统求值。新 check 程序值增加 optional stepId（新结果实际写入，旧结果不回填）；它仅用于选择**同根真实账本事实**，不是权限或成功认证。自述的 passed/source/输入 hash 不参与认证。无效句柄被记为 null，不能污染可恢复账本。
- main 在原共享槽位和独立系统账本上先写 verification intent（仅保存具名 stepId selectors 和 baseline），再读证据、写不可变结果和 outcome，之后才推进控制帧。不产生 Agent attempt，也不自动运行缺失检查。全根 SystemSteps 上限仍16384，未知 effect、根预算、CAS/epoch 及停止/恢复合同不变。
- 准备计划时的系统需求探测仍能找到此步骤的依赖：每个合法 verification 至少声明一个程序内 check；空集合、外部或虚构 check 无法编译。没有额外宿主探测或 fallback。

## 什么可以成为 available

每个选择必须在 verification intent 之前提交，且其实际 intent.nodeId 等于要求的 check。main 核验：

1. 同根已完成、settled 的 check intent/outcome 与不可变 result；真实状态字段必须与不可变程序值一致。
2. stdout、stderr、适用 diagnostics artifacts 均存在且通过原 hash 校验。
3. 完整 before/after/changes 与原 intent、不可变分片及物化来源关联一致；缺少或未知证据不变成零。
4. main materialization available；同组所有检查必须绑定同一个来源候选身份及实际物化 inputHash。每个检查应从同一候选版本创建独立验证副本，避免前一个检查的缓存产物污染下一个的 before。

集合的 passed 仅表示这些**具名、冻结、归属完整的命令实际通过**，不是代码正确、风险为零、测试覆盖完整或整体质量成功。任何缺项、错误目标、未知 scope 或不同候选版本都不能获得此结论；不可用值没有 passed。证据文件丢失/校验错误保留失败，不执行补证据。

结果的 candidate（如存在）是来源副本身份，其 inputHash 仍是候选**最初创建**的 hash；单独的 inputHash 才是这些检查验证的物化版本。后续候选改变不会让旧事实变成新版本，也不会触发重跑。返回的 JSON 副本引用不具有 fork/Agent 执行权限。

## 诊断归一与基线比较

- TypeScript 诊断来自原 parser 的 derived artifact。按 frozen check.cwd 和实际 owned copy 根归一到相对文件路径；绝对外部路径、无法识别或超限为 unavailable，不伪造空数组。保留大小写及消息内部空格，只归一换行。
- 对相同文件/行/列/code/message 的重复行去重；再按具名检查、相对文件、code、message 形成**保留数量的多重集**。行号移动不是错误消失，同文错误在不同位置不会合并成一个。该比较是 derived 的类别数量差异，不证明某个具体错误被修复，也不能区分同类错误先消失再出现。
- baseline 必须选择同根先前完成的 verification；具名要求集合及每项完整 frozen authorization hash（argv/cwd/parser/timeout、环境、executable/interpreter/入口指纹）必须一致，不能把换命令、跳测试或换解析器称作可比。
- 比较前仍读取基线原检查证据；不是信任一个绿色 JSON。一次汇总内相同检查证据请求合并到有界临时 Map，不跨版本缓存。回归/恢复的检查 key 和诊断 added/removed 分开；无解析诊断时仍可报告已知检查退化，但诊断差异保持 unavailable。
- 诊断多重集最多4096组、最多2 MiB；差异 added+removed 合计最多4096组。最终数据仍受原4 MiB值上限约束；若组合证据过大，诊断明确 unavailable，不截断成完整成功。64命令是本阶段上限，超过时编译拒绝；真实需求超过此界限时，先补根证据体积预算再升级，不静默拆分或放宽。

## 继续与权威边界

父 checkpoint 失败后可复用已提交 verification，不追加 intent 或启动 native/Provider。冷恢复核验 selectionHash、原冻结要求、依赖事实和重算的纯比较结果；只比对并返回原不可变值，不补写缺失证据。selector 被重写、依赖缺失或不一致时拒绝恢复。纯比较的重算不是业务 effect 重发。

**progress 永远 unavailable，附明确原因。** 目前没有测试覆盖、验证范围/受保护输入完整性合同，也没有候选优胜或自动写回策略。删测试、少输出、错误数减少、检查变绿均不能据此认证可信进展。后续由 main 实现验证范围证明及质量策略，再接独立复核/classifier；真实 Provider/Jev、成本和业务应用仍另需授权。

## 本地验收范围

- focused 覆盖真实离线 Agent 修改候选后多命令 fork/check/汇总、归一与退化、虚构/错误目标、不同 frozen contract、诊断不可用、checkpoint cut 后冷继续、selector 篡改、缺原证据、编译与上限。
- 负控强制将实际检查 passed 改为 true，首项关键回归明确失败；恢复真实谓词后再验证。没有删除断言或增加 deadline。首轮测试错误地保存旧 epoch 被生产 fence 正确拒绝，拆成独立场景；没有修改 fence。
- 生产模板/审批/preload/main/Service/Runner 验收新增两个具名要求、四次本地 Node、两次 verification。Node 独立读取已持久化物化 intent；phase-dependent fixture 输出 TS100 的行号移动、TS200/TS300 新增及 tests 退化。零 Agent/Provider 增量，源目录不变，重复 start 不重放。这不是实际 tsc、真实 SDK、修复有效性或发布验收。
- Program 旧大文件按 fields/block parsing/reference typing 拆分；原 API 与 loop weak-map 读取保持同源。Interpreter 的结果优先级辅助移到 results 模块，未新增解释器。所有本次改动仍走原20,000字节完整暂存文件门禁。
- Node/web types通过；24文件274/274相关检查通过（102.64s、10核load9.41→11.39、highLoad=true），最后的宿主缺失拒绝 guard 后另跑6文件54/54及完整 build + production conversation IPC，通过。Chromium 原生交互 fixture 验证汇总行显示“已记录”而非假造“已通过”，并保留430px布局、焦点及审批/停止/恢复交互。
- 扩大组合38文件428项中427通过，历史同名1000-attempt用例仍在原5000ms超时（load15.11→15.85、highLoad=true），不是全绿。随后把本轮新增的 check 索引改为仅 verification 用到时建立，普通程序不做额外全图扫描；未重跑扩大组合刷绿，不能断言该超时已修复或本轮完全无影响。首败、改动前后相关检查和环境分别保留。
- AST核对证明20个原 Program 函数除新增 verification 分支/提示词/惰性索引外保持一致，4个 Interpreter 方法及结果优先级保持；不是删除权限校验来满足文件门禁。日志：`/tmp/scry-workflow-template-editor.ZnkC6L/verification-*`。
- providers.catalog 仍缺匹配 collector；不能宣称性能门禁通过或提速。历史扩大组合1000-attempt/CLI/延期失败不由本轮 focused 通过关闭。
