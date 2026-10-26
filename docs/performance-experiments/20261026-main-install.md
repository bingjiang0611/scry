# 2026-10-26：main 集成与 0.2.226 安装

## 交付结果与授权范围

用户要求把`reliability/collection`合入`main`并安装。验证期间开发分支新增`c4eb154f`；用户随后明确选择**安装已验证版本**，因此本次冻结在`6e2012e7`，不纳入该并行提交。

- 合并：`7a1c4a60ce1a850c1c7357c236f5f19dd36b5163`，父提交为`ab721af5`与`6e2012e7`；tree为`720efd31150a43468b8fc57f7de84df0d721e105`。
- `main`工作区：`/Users/baobingjiang/IdeaProjects/vibecoding/scry-main-diff-integration`。已通过正常快进更新，没有强制重置、覆盖开发分支或复制WIP。
- 已安装：`/Applications/Scry.app`，App **0.2.226**，内置CLI **0.2.51**。没有更新全局npm CLI。
- build：`25eb32d09e460c642056f6061a799e1fd01744507d2b917f9b934b405812fda3`。从打包的asar提取，并用合并提交的冻结源码重新计算匹配。
- 回滚备份：`/Applications/.Scry.app.backup`，确认版本0.2.225。
- 未push，未重启用户实例。用户自行重启后加载新版。本次是开发构建，未作Developer ID签名/公证发布声明。
- 安装后的检查发现main工作区另有其他任务的未提交修改；这些WIP不在本次构建、验证或提交中，未覆盖或暂存。

这完成的是冻结版本的合并与安装，不是三套架构路线全部完成，也不是L3日常性能验收。`c4eb154f`留在开发分支，后续是否交付另行决定。

## 合并冲突如何解决

四个冲突文件均保留两侧功能，而非整体覆盖：

1. `useIntegrations.ts`、`useSessionModels.ts`采用main已有职责拆分。把取消无消费者stats/billing自动读取接入`useUsageInsights.ts`，保留main的工作区diff路径和会话模型合同；删除另一套重复hook/helper。涉及的分析文案仍集中管理。
2. `workspace-diff-ui-checks.mjs`同时保留main新增的历史作用域/迟到回复围栏检查，以及统计查询为零、活跃分析继续刷新的回归。
3. DesktopRemote使用四个独立场景的真实模块实现；删除main旧的重复夹具模块。main的444个`check/wait`调用表达式逐项对照：唯一既有差异是独立host场景以初始提交数而非跨场景常量3验证“没有启动Provider”。新增的三个等待保留；13种配置生成的TSX与main逐字相同。
4. 随main组件拆分更新五项mutation目标的实际文件路径。机器路由负对照改为移除`app-view.tsx`中的远程分支，仍模拟错误切回本机；未改产品源码或正向断言。

三个旧交接报告超过20KB完整文件门禁。按实施、验证和修订阶段拆分为13份记录，原`A.md/B.md/C.md`保留索引与章节标题。恢复记录的章节边界空行后，可逐字重建全部原文。没有删除证据或豁免门禁。

App版本仅由0.2.225升为0.2.226。依赖定义未变化；沿用已有版本升级方式，未改仅含旧根版本元数据的lockfile。独立`npm ci`成功，依赖解析仍由同一lockfile固定。

## 当前版本验证

mac2：Apple Silicon / Node24.18.0 / Electron42.10.1；全部使用临时工作区、独立userData和受控Provider，无真实付费调用。

| 检查 | 结果与范围 |
|---|---|
| 类型检查 | Node与renderer均通过 |
| focused | 19文件、157用例通过，含hook、native pointer、场景组织和台账 |
| 全量unit | 383文件，4199通过、4项原有条件跳过、0失败；`--no-file-parallelism`仅串行化文件，不改断言、测试范围或超时 |
| shell | `npm run test:shell`退出0 |
| 完整renderer UI | 原package脚本28段连续执行退出0；包括Credits、四个DesktopRemote场景、真实临时Git、生产workspace首次发送与diff工作台、conversation IPC和Pi历史 |
| 五项负对照 | background task-stop泄露、错误本机路由、MetaPrompt错误返回、错误设置入口、metadata更新不刷新controls均由真实业务断言拒绝 |
| 性能门禁 | 同机、冻结同一collector与依赖对照main `ab721af5`：74项观测、全部gating通过；3项CPU候选未采集，不记0 |
| 产物 | `npm run pack:artifact`通过构建、独立CLI构建、打包、依赖完整性和全部默认Electron smoke |
| 本机安装 | 转运后再跑原`check-packaged-app.mjs`与原子安装器；安装前后清单一致，App/内置CLI版本读回符合预期 |

完整UI的负载3.24→8.32/8核，performance命令17.87→26.84，均`highLoad=true`。本轮只确认行为和L1计数，不用这些墙钟时间宣称L2改善。历史UI焦点/几何偶发失败没有因此被宣布根治；之前的原始失败记录仍保留。

### 性能结果没有被合并抹掉

固定输入下：后台SQL130→0，内容复用SHA64→32，双权威目录元数据操作167→85、sync116→88，远程投影前缀读取100020→0；必要的数组复制仍100000。

仍有三个历史candidate高于台账：readdir20（基线18）、archive IPC10558（10536）、cold stat44（36）。前两项本轮A/B相同；第三项是已记录的用stat替代必失败mkdir的必要工作。未调整基线、容差或门禁地位。读取payload的A/B为1397915→1397922字节；这是已有易受文件指纹序列化影响的候选指标，本轮没有逐字回溯这7字节，也不宣称其减少或放宽标准。

## 首次失败与恢复路径

- 本机依赖复制在180s外层期限退出，未进入typecheck；当时本机load约132。没有重放未知复制或干扰现有App，改在已授权mac2工作。
- 打包流程的SSH外层调用超时。随后只读核验发现远端已完成全量unit和shell（均0），并在产物依赖检查退出1；没有把超时当作测试失败或重跑全量来挑绿。
- 首次打包使用共享`node_modules`符号链接。打包器遗漏传递依赖，检查正确拒绝`@opencode-ai/sdk → cross-spawn`。确认源依赖存在后，移除仅属于本实验的符号链接，用同一lockfile独立`npm ci`，重跑`pack:artifact`通过。没有绕过检查或修改allowScripts；6个既有生命周期脚本的待授权警告保留。
- Provider revision负对照最初误选hosts场景，随后误用未识别的`--opening-only`，两次均未覆盖目标，不计为敏感性证明。查明真实入口后，用`--session-opening-only --negative-provider-revision-control`得到预期的“same-context metadata invalidates selected controls”失败。未削弱断言或修改生产刷新逻辑。
- 拆报告时章节分隔空行触发`diff --check`，改为文件末尾单换行，并在清单记录重建所需分隔符；原文字节重建仍严格相等。

## 产物身份与安装流程

App大小287347001字节，小于既有330MiB上限；311条运行时传递依赖检查通过，sandbox preload为CJS，node-pty与私有CLI齐全。Qoder SDK存在，不额外打包Qoder CLI；不据此宣称真实Provider验收完成。

- 转运zip SHA256：`1dd204feb7a55fde60001f0c26f9217f4082df033acc6d47782b88c29a0ef0b9`。
- 安装清单SHA256：`f5581f7f96bbd3c4d158862786d0d995509f5613efc0c404ce54bb5ac025d864`。
- 清单覆盖478个文件/目录/符号链接，其中369个普通文件；比较文件内容、权限位和链接目标，不声称比较所有扩展属性或文件系统时间。
- 远端测试树、提交tree与本机main一致。构建发生在合并提交前；构建后代码未变，提交tree和重新计算的build ID把产物绑定到`7a1c4a60`。

沿原`install:mac:dev`的检查链分步执行：mac2运行typecheck、完整unit（串行）、shell、`pack:artifact`；本机验证转运清单，再调用原`check-packaged-app.mjs`和`install-macos.mjs`。不是跳过`pack`中的检查，也没有在mac2安装到其`/Applications`。

## 记录与后续

[结构化证据](20261026-main-install-evidence.json)。本机完整日志及清单保留在`~/.local/state/scry-main-performance-install.It2NU2/`，远端为`/Users/test/scry-performance-climb-mac2.cO3N5W/logs/main-delivery-226/`。保留首次失败、错误场景运行和原报告重建证据。临时worktree与包未自动删除；进程检查只证明当时没有cwd位于自有根目录的进程，不扩大成全机器子进程收敛保证。

本次交付完成。用户可自行重启加载新版本；真实Provider、其它平台、L3样本和被明确排除的`c4eb154f`不属于本次通过项。
