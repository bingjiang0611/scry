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
  baseline: { kind: 'ref', name: 'baseline_verification' }, // optional
  protectedPaths: ['package.json', 'tests', 'tsconfig.json'] // optional, literal paths
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

## 声明保护范围与端点证明

`protectedPaths` 是冻结程序中的可选字面量声明，不从 Agent 输出取得，不授予权限、不自动发现测试。1–256个非空、不重叠、区分大小写的项目相对路径；每个最多1024个UTF-16单元。不接受根路径、点段、空段、反斜线、控制字符、冒号、通配符及 `.git`/`.scry`。目录匹配完整路径段及全部后代，不把 `tests2` 当作 `tests`。校验后排序，重复/重叠直接拒绝；路径文本计入原4 MiB程序预算。

main 的可选 `protectedSurface` 来自原不可变清单，不信任结果 JSON 的标签：

- 有 baseline 时，具名冻结命令与 `protectedPaths` 必须一致。以基线第一个具名检查的 before 为参考，比较当前与基线**全部必需检查**的 before/after。没有 baseline 时，只证明本组检查端点相对第一个 before 保持，**不是证明 Agent 没改过测试**。
- 参考清单必须实际包含每个声明路径。文件与目录的路径、类型、hash、mode、bytes及后代增删均参与比较。声明下出现 symlink 时 unavailable：尚无其目标闭包证明。不是只比较错误数或输入总 hash；未声明输入可以变化。
- `available + source:main_manifest` 记录冻结路径、referenceStepId/referenceInputHash、参考条目数及已验证观察数。参考选择、保护端点变化、路径缺失、范围变化、symlink目标不完整或超限均 unavailable；不伪造空集合或回填旧结果。命令实际 passed 可与保护证据 unavailable 并存。
- 原读取流程先校验 header、全部分片和原始清单 hash，之后在**同一次读取**中交给纯投影观察器，不重读存储、不打开清单里的路径、不启动额外命令。相同 inputHash 复用投影，但每个独立 header/关联仍验证。一次汇总对不同清单最多处理16 MiB；单清单原8 MiB/32768项、系统槽位/预算/恢复及最终4 MiB值限制不变。真实需求超过16 MiB时，先引入分页保护投影及根证据预算，再升级；当前不能截断成可用证明。
- 冷继续重读原清单并重算投影，必须与原不可变结果一致；后续真实候选变化不改写历史版本。缺参考分片时拒绝，不启动 native 或 Provider 补证据。旧程序不声明路径时，不增加清单解析/投影字段，也不回填旧结果。

**这只是声明路径的快照端点保持，不是完整验证范围、执行覆盖率或全程只读证明。** 清单不含mtime/xattrs，未声明输入不受此证明约束，瞬间修改后还原不可从端点发现；没有防写、原子快照、完整审计或安全沙箱。空测试目录保持不变也不能证明运行了测试。`comparison.progress` 继续 unavailable；测试发现/执行集合、跳过/失败分母、受检版本及独立复核仍需单独合同。

## 继续与权威边界

父 checkpoint 失败后可复用已提交 verification，不追加 intent 或启动 native/Provider。冷恢复核验 selectionHash、原冻结要求、依赖事实和重算的纯比较结果；只比对并返回原不可变值，不补写缺失证据。selector 被重写、依赖缺失或不一致时拒绝恢复。纯比较的重算不是业务 effect 重发。

**progress 永远 unavailable，附明确原因。** 目前只有声明保护范围的端点证明，没有测试覆盖或验证范围/受保护输入的完整性证明，也没有候选优胜或自动写回策略。删测试、少输出、错误数减少、检查变绿均不能据此认证可信进展。后续由 main 实现验证范围证明及质量策略，再接独立复核/classifier；真实 Provider/Jev、成本和业务应用仍另需授权。

## 保护范围增量验收

- 新增13项：离线 Agent 改非保护输入后，两次真实 Node 检查及四端点；保护文件内容/mode/删除/新增后命令仍过但保护证明不可用；native只改after端点；相似前缀、缺路径、symlink、冻结范围变化；父checkpoint cut后冷复用、缺原分片拒绝无重跑；编译拒绝/上限；合成单份合法清单累计超过16 MiB的预算及同hash投影复用。
- 负控移除真实投影差异谓词，native改保护文件的测试明确失败（错误地产生available）。恢复原源码逐字比对后验证，无断言/deadline放宽。首轮类型检查的unknown属性闭包与fixture误用resume/私有存储均修正为实际公共合同；没有改生产fence。
- Node/web types通过；24文件283/283串行相关检查通过（Vitest99.57s，10核load6.86→5.55，highLoad=false；不是提速测量）。build +完整production conversation IPC通过：个人模板冻结保护脚本，四个实际本地Node检查、八个原始观察得到保护端点保持；具名tests仍退化、progress仍unavailable，零Agent/Provider增量、源不变、重复start不重放。不是实际tsc或完整测试覆盖验收。
- 日志 `/tmp/scry-workflow-template-editor.ZnkC6L/surface-*`。collector、1000-attempt组合与旧CLI/延期失败仍未关闭。本轮没有运行真实Provider/Jev、推送、安装、升版本或应用业务patch。

## 先前增量验收（223b8b27）

- focused 覆盖真实离线 Agent 修改候选后多命令 fork/check/汇总、归一与退化、虚构/错误目标、不同 frozen contract、诊断不可用、checkpoint cut 后冷继续、selector 篡改、缺原证据、编译与上限。
- 负控强制将实际检查 passed 改为 true，首项关键回归明确失败；恢复真实谓词后再验证。没有删除断言或增加 deadline。首轮测试错误地保存旧 epoch 被生产 fence 正确拒绝，拆成独立场景；没有修改 fence。
- 生产模板/审批/preload/main/Service/Runner 验收新增两个具名要求、四次本地 Node、两次 verification。Node 独立读取已持久化物化 intent；phase-dependent fixture 输出 TS100 的行号移动、TS200/TS300 新增及 tests 退化。零 Agent/Provider 增量，源目录不变，重复 start 不重放。这不是实际 tsc、真实 SDK、修复有效性或发布验收。
- Program 旧大文件按 fields/block parsing/reference typing 拆分；原 API 与 loop weak-map 读取保持同源。Interpreter 的结果优先级辅助移到 results 模块，未新增解释器。所有本次改动仍走原20,000字节完整暂存文件门禁。
- Node/web types通过；24文件274/274相关检查通过（102.64s、10核load9.41→11.39、highLoad=true），最后的宿主缺失拒绝 guard 后另跑6文件54/54及完整 build + production conversation IPC，通过。Chromium 原生交互 fixture 验证汇总行显示“已记录”而非假造“已通过”，并保留430px布局、焦点及审批/停止/恢复交互。
- 扩大组合38文件428项中427通过，历史同名1000-attempt用例仍在原5000ms超时（load15.11→15.85、highLoad=true），不是全绿。随后把本轮新增的 check 索引改为仅 verification 用到时建立，普通程序不做额外全图扫描；未重跑扩大组合刷绿，不能断言该超时已修复或本轮完全无影响。首败、改动前后相关检查和环境分别保留。
- AST核对证明20个原 Program 函数除新增 verification 分支/提示词/惰性索引外保持一致，4个 Interpreter 方法及结果优先级保持；不是删除权限校验来满足文件门禁。日志：`/tmp/scry-workflow-template-editor.ZnkC6L/verification-*`。
- providers.catalog 仍缺匹配 collector；不能宣称性能门禁通过或提速。历史扩大组合1000-attempt/CLI/延期失败不由本轮 focused 通过关闭。
