# Scry · Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

本文件覆盖 Scry 桌面端与原生 iOS 配套端的共同产品事实。桌面端使用 Electron、React 和 TypeScript，当前主要在 macOS 开发与验证；iOS 产品端为 SwiftUI 实现的 ScryRemote，当前要求 iOS 17+。两个端共享产品语义，但保留各自的平台交互，不要求界面或能力完全一致。这里的 adaptive 不代表已有 Android 产品。

## Users

主要用户是个人重度开发者：频繁使用多个 AI coding agent，需要管理会话，并检查执行过程和结果。这一受众由维护者在本次初始化中确认；不把团队协作、企业管理或大众市场需求当作默认前提。

## Product Purpose

让开发者看清 Agent 做了什么、依据是什么，以及哪些事情仍无法确认。

Scry 是本地优先的 AI coding agent 观测与治理应用。它在桌面端驱动本机 Provider CLI/SDK，将执行过程呈现为可检查的对话、工具调用、文件足迹、用量、诊断和干预入口。iOS 配套端通过已配对的宿主查看会话并继续工作。

维护者确认的首要产品价值是“看清 Agent 做了什么”。成功意味着用户能够判断执行状态、检查实际证据、识别证据缺失，并据此决定是否继续或干预；不能仅以界面显得完整或流程更短作为成功标准。

## Positioning

Scry 不只是聊天外壳，也不是安全沙箱。它把本机 Agent 的运行入口、执行证据与干预放在同一工作流中，显式保留 Provider 的能力差异和证据来源。

本地优先不等于离线，也不等于数据永不离开设备。Provider 会连接各自服务；获批工具及已授权远程访问也有各自的数据边界。

## Operating Context

- 桌面主流程：选择项目与 Provider，创建或恢复会话，发送任务，观察流式输出与工具调用，按需停止或处理审批，再检查历史、变更与用量。
- 用户需要本机已安装、已登录的受支持 Provider。可用模型、权限模式、恢复与审批能力由当前 Provider/runtime 决定。
- iOS 是宿主配套端，不是独立执行 Provider 的替代宿主。配对、宿主可达性、项目授权与当前能力决定哪些操作可用。
- iOS 的正常配对入口是扫描真实短时二维码并由 Mac 确认。已配对不等于已连接；缓存历史不等于当前运行状态。
- 会话索引、观测数据和归档以本机存储为基础。独立 `@ali/scry-turn-recorder` CLI 在 macOS/Linux 的 Node 环境运行，只写工作区 `.scry/`，不是第三套产品界面。

## Capabilities and Constraints

### 能力与证据

- 桌面端提供会话、工具调用、文件足迹、用量、诊断及运行控制。Claude 是主要路径；Codex、Qoder、OpenCode、Pi 仍是实验性路径，不承诺能力对齐。
- `exact`、`estimated`、`inferred`、`partial`、`disabled`、`unavailable` 表达不同的证据状态，不能只作为视觉样式处理。
- “没有工具调用”与“Provider 不提供工具证据”必须区分。缺失的 token、cost、duration、文件或风险证据不能显示成零、无风险或已完成。
- 对话原文、Provider result、Hook、trace、聚合数据与 turn record 的权威性不同。合并展示保留来源，避免重复统计调用或用量。
- 远程发送结果未知不等于没有执行；恢复和重试不能靠猜测成功或失败来推动流程。

### 安全与隐私

- Scry 不是安全沙箱。Provider 与获批工具仍以本机用户权限执行；文件足迹不是完整审计日志。
- `full_access` 是用户明确选择的 Provider-specific 运行模式，不是更强隔离，也不能绕过仓库配置的独立 trust/fingerprint 校验。
- 项目 MCP、Hook、plugin 与 recorder commit callback 按现有政策自动授权，但执行前仍校验 canonical cwd、内容和 executable 指纹；校验失败拒绝执行。自动授权不能显示成用户批准。打开不可信仓库可能执行本机代码。
- Renderer 无特权。后续设计不得通过放宽 IPC、路径授权、导航限制或 sandbox 来换取便利。
- 采集的对话与工具输出默认保留原文，可能含敏感信息。本机备份、导出和已授权远程设备可能接触这些内容；不得承诺自动脱敏或绝对隐私。
- 远程目录与文件操作必须遵守对应端点的宿主授权边界。浏览不等于授权，桌面专用目录选择能力也不能用于放宽手机原有项目根范围。

详细合同以 `CLAUDE.md`、相应领域文档和生产实现为准。本文件不改写权限策略，也不将文档中的能力描述视为当前版本端到端验收结果。

## Brand Commitments

保留产品名称 Scry，以及现有应用图标。未确认新的口号、品牌性格或语气方向。

本次初始化不选择配色、字体、布局或视觉世界；现有桌面与 iOS 实现是后续局部优化的参考，不因缺少 DESIGN.md 而视为全新项目。

## Evidence on Hand

- `README.md`：产品定位、Provider 状态、本地数据与分发边界。
- `CLAUDE.md`：证据诚实、权限、trust、renderer 隔离及验收合同。
- `docs/agent/architecture.md`：术语、架构和代码定位。
- `src/renderer/`：桌面端现有实现；涉及文案优先复用 `src/renderer/constants/copy.ts` 与 `src/shared/constants/copy.ts`。
- `apps/ios/README.md`、`apps/ios/ScryRemote/`：原生配套端的实现、合同与验证记录。ScryRemoteG0 是隔离验证应用，不是产品。
- `build/icon.png`：现有桌面应用图标。
- `src/shared/turn-record.ts`、`packages/turn-recorder-cli/README.md`：轮次记录合同与独立 CLI 边界。

这些材料是产品与实现依据，不是客户背书或效果基准。本次未建立用户规模、提效比例、客户评价或公开部署的证据，不得补写此类宣称。

## Product Principles

1. **先让执行可理解。** 围绕用户判断“发生了什么”组织信息，观测用于支持决定，而非堆叠指标。
2. **证据诚实优先。** 区分事实、估计、推断与未知；不能用完整外观掩盖缺失证据。
3. **差异显式存在。** Provider 和平台能力不同，不能为统一界面假装一致。
4. **控制不夸大保护。** 清楚说明操作后果、权限与 trust 的区别，不把观测包装成隔离。
5. **跨端共享语义，不共享假状态。** 保留平台交互习惯，以真实宿主交换、回执与来源判断连接和执行状态。

## Open Decisions

- 未指定产品级无障碍验收标准或特殊受众需求。后续涉及具体界面时，应确认相应验收范围；未指定不代表允许削弱现有可访问性。
- 未确定新增市场定位、商业模式或公开发布承诺。后续需要这些信息时由维护者明确决定，不从当前实现推导。
