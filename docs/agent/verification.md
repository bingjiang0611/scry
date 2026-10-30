# scry · verification

按任务读取相关小节，不要求每次全文读取。代码块与行内路径均相对仓库根；命令执行前核对实际文件和 package scripts。当前根指南见 [CLAUDE.md](../../CLAUDE.md)。

## 测试约定

- 测试与实现 colocate 为 `*.test.ts` / `*.test.tsx`；Provider wire 差异使用 fixture/contract test，不用 shared mock 抹平。
- Provider 发现链路同时覆盖 fast/full 两阶段探测、版本探测超时收敛和已保存的自定义 Profile；扫描中不展示中间卡片，完整结果一次展示。
- trust、permission、path、IPC 和 deletion 逻辑同时测试 allow 与 deny/mismatch/stale 路径。
- evidence 测试要覆盖真实空值、不可观测、partial、重复和乱序，不只测完整 happy path。
- Recorder 测试覆盖 crash fence、原子写、lock recovery、duplicate event/Stop、cursor 与 corrupt record。
- 不用固定 sleep 掩盖竞态；等待 receipt、事件、进程退出、文件原子出现或 queue drain。
- 自动化 Electron 测试默认不显示窗口、不激活 App、不抢系统焦点。
  - 完整 App fixture 设置 `SCRY_TEST_APP=1`，renderer ready、启动兜底和 second-instance 均不得显示窗口。独立 fixture 在 macOS ready 前设置 `app.setActivationPolicy('prohibited')`，窗口全程保持 `show: false`；需要后台动画帧时仅为测试关闭 `backgroundThrottling`。`showInactive()` 仍会显示窗口，不能用于默认自动测试。
  - 使用 `scripts/hidden-electron-windows.cjs` 在创建窗口前安装检查：拦截显示/原生焦点调用并失败退出，不先弹窗再隐藏。完整 App 的 `node scripts/external-links-smoke.mjs` 检查启动各路径全程隐藏、后台动画帧及原生坐标输入。
  - 保留 Chromium 原生输入与页面内焦点检查，不用 `win.focus()`。后台测试不等于前台 OS 焦点/Dock 验收，确需此类验收时先征得用户同意。LLM 面板原生隐藏/恢复刷新验收保留在 `node scripts/session-capability-ui-smoke.mjs --performance-only --native-visibility`，仅获准弹窗后运行；默认测试明确报告该项 `not-run`，不冒充原生可见性验收通过。
  - Dock attention 专项运行 `node scripts/electron-security-smoke.mjs --dev-question-only --foreground`。未传 `--foreground` 时在启动 App 前拒绝执行，不删减焦点/角标断言。
  - 崩溃重载后的会话级恢复（真实 Provider 一轮 + `forcefullyCrashRenderer`）用 `npm run smoke:session-restore`。它跑真实轮次、消耗 Provider 额度，因此不进默认门禁；默认 `smoke:electron` 只覆盖夹具级恢复（侧栏 tab、工作区、重启提示）。
- 当前仓库没有 ESLint/Prettier 命令，不要发明不存在的门禁或做大范围无关格式化。

迭代时运行最小相关检查：

```bash
npx vitest run src/main/providers/codex.test.ts
npm run typecheck
npm run build
```

## 覆盖率与 fixture 隔离

- `npm run test:coverage` 使用与 Vitest 匹配的 V8 插件，统计 `src/` 生产 TS/TSX；仅排除测试、benchmark 与类型声明。Node CI 用这一次运行替代普通 unit run，并上传 `coverage/`，不重复跑两遍套件。
- 定向报告：`npm run test:coverage -- src/main/git.test.ts src/main/providers/pi-lifecycle.test.ts`。定向报告不是全仓覆盖率；对比必须固定源码、测试范围和工具版本，不能把其他并行 WIP 的变化归功于本次测试。
- `--coverage.reportsDirectory=<独立目录>` 会清理原报告目录；禁止指向源码或基线备份。默认 `coverage/` 已忽略。
- Git fixture 隔离宿主 config、hooks、模板和仓库定位环境，但保留临时仓库本地 config，以便真实验证恶意 filter/hook 的防护。Pi lifecycle fixture 固定测试 Node/HOME，只有专门的 Node 探测测试才控制探测边界；RPC 和进程退出仍走真实子进程。
- 覆盖率只用于寻找缺口，不等于验收成功。尤其不得把 malformed wire、未确认退出、丢失快照或超时改成成功空结果来提分。

## 验证与交付

默认选择能证明本次改动的最小验证，不把完整发布门禁作为每次小改动的前置条件。仅当用户要求预览、改动涉及 UI/交互或需要真实 App 验证时，启动包含当前改动的开发版本；CLI、脚本和非界面逻辑改动不默认启动。用户明确要求不启动时遵循请求。供用户检查时使用正常用户数据和工作区；自动化测试、破坏性验证或用户明确要求隔离时才使用临时数据。

### 纯文档或 Agent 配置

```bash
git diff --check
```

同时核对 Markdown、引用路径、命令、Provider/安全边界与版本示例。纯文档不构建 App/CLI、不升版本。

### 普通代码改动

开发中运行受影响测试；普通 App 代码交付前至少运行：

```bash
npx vitest run <affected-test-files>
npm run typecheck
npm run build
git diff --check
```

- 修改 conversation 原生归属、启动恢复或旧入口阻断时追加 `npm run test:conversation:ipc`：隐藏的隔离 Electron 通过生产 preload/main IPC 验证，使用测试 Provider 入口收据与正对照，不访问真实账号；该检查也纳入 macOS `test:renderer:ui`。
- 修改 workspace Hook 时追加 `npm run test:shell`。
- recorder Core、CLI、integration 或 npm 包的普通改动先运行受影响合同测试及必要的 `npm run build:cli`；跨公开合同的高风险改动或准备 CLI 分发时才运行 `npm run check:cli-release`。
- 修改 packaging、preload、native dependency、resource allowlist 或 Electron security 时，macOS 追加 `npm run pack:artifact`；Linux 按下节运行对应产物检查与 focused smoke，不把 macOS 通过当作 Linux 通过。
- 本机 ignored 的 `.claude/`、`.agents/` 等 Agent 目录可能污染 Vitest 自动发现；应限定到项目自有 `src/`、`scripts/` 测试或在 clean checkout 运行，不要删除用户配置来让测试通过。

### Linux 验证与交付

macOS 与 Linux 是共享代码的维护目标。跨平台边界、共享 UI、原生依赖或打包变更，应在两端运行受影响检查；纯平台专属改动说明为何另一端不受影响。不要求每次小改动跑完整发布流程；无 Linux 环境时保留未验证项和目标机/CI 验证动作，不伪造通过。

Linux 产物检查流程（仓库根、已安装依赖的 Linux 环境）：

```bash
./node_modules/.bin/electron-builder install-app-deps
npm run build && npm run build:cli
node scripts/run-electron-builder.mjs
npm run check:packaged-app
# 涉及 pacman、桌面入口或准备 Linux 分发时：
SCRY_RELEASE_BUILD=1 node scripts/run-electron-builder.mjs
npm run check:pacman-package
```

- pacman 构建/检查需要 `bsdtar`（Ubuntu 包名 `libarchive-tools`，Arch 为 `libarchive`）。`packaged-linux` CI 检查解包 App 与 pacman 元数据，不包含 GUI/Hyprland 验收。
- 当前 `npm run pack:artifact` / `npm run pack` 会调用整套 `smoke:electron`，其中 `scripts/desktop-remote-host-smoke.mjs` 仍按 macOS 布局取可执行文件；它们不是 Linux 全套可用入口。需要改该 smoke 时适配共享布局并补 Linux 验证，不能静默 skip 或声称整套通过。
- Linux 显示环境与 Chromium sandbox 可用时，运行 `node scripts/electron-security-smoke.mjs`；无桌面但有 Xvfb 时可用 `xvfb-run -a node scripts/electron-security-smoke.mjs`。不使用 `--no-sandbox` 或默认禁用 GPU；fixture 环境配置不写进产品默认值。
- Xvfb 下动画可能 pending。布局坐标、视觉动画、原生命中与焦点是不同证据；布局检查不得冒充视觉/交互验收，也不得删除共同布局断言来消除平台失败。
- headless wlroots 的 `app_id` 检查只证明运行时标识；Hyprland 窗口关联、中文输入、分数缩放、真实密钥环、安装/升级/卸载仍需目标机。Provider 真实请求另需账号/费用授权。
- Linux 不运行 `install:mac:dev`。生成包不等于安装；`sudo pacman -U <本次已检查的包>` 属于系统级变更，须获明确授权。报告 OS/架构、产物版本、实际检查及未验证项；容器 arm64 结果不证明 Arch x86_64 可用。

背景与历史证据：[技术方案](../research/linux-omarchy-technical-plan.md)、[本地验证记录](../research/linux-omarchy-local-verification.md)。历史记录不能替代当前版本验证。

### UI / 交互修复验收

- 修改前明确用户原始操作步骤、预期结果和受影响的状态转换，不只修截图中的单一状态。按本次范围检查首次/连续多轮发送后立即停止、原生 turn ID 尚未建立/已建立，以及侧边栏开关、固定/悬浮摘要、滚动与焦点等相邻路径；保留 Provider 差异。
- 把原始复现步骤和最容易回归的相邻操作补成少量针对性用例；涉及事件顺序或 UI 接线时，不能仅靠纯函数测试证明交互正确。再次收到“仍不行”时先补全遗漏的状态或时序，再修复并补回归用例。
- 在包含当前改动且 main/preload/renderer 版本一致的 App 上重放原始操作，确认目标行为与相关反向操作；构建成功或 App 已启动不等于原问题已验收。
- 交付分别说明编译/构建、自动测试、原问题真实交互验收的结果与实际范围。截图/观察失败、Provider 不可用或未执行时明确标注，不把前两项写成真实验收通过；这些 focused 用例不额外触发全量发布门禁。

### 完整 CI / 发布门禁

以下情况才运行完整套件：用户明确要求；改动跨越 Provider/trust/persistence/recorder/IPC/packaging 多个核心边界；准备高风险合入；或构建可安装/正式发布版本。

```bash
npm run typecheck
npm test
npm run build
npm run check:cli-release
npm run pack:artifact
git diff --check
```

完整 gate 对应 Node 22 App、Node 20/22/24 CLI compatibility 和 macOS packaged Electron security smoke。涉及真实 Provider、OAuth、账号、MCP server 或平台行为时另做 L3，并明确哪些未执行。

## 版本、打包、安装与发布

App 与独立 CLI **分别版本化**；不要默认每次 App 修改都升 CLI，也不要漏升实际改变的分发面。

- 纯文档/Agent 配置不产生新 App/CLI 产物，不为此单独升版本。
- 普通 App 源码提交不自动升版本；准备新的可安装版本或正式发布时，源码冻结后才升一次根 `package.json` version，并重新跑完整验证与打包。
- 普通 CLI 源码提交不自动升版本；准备分发包含 CLI 合同、命令、integration 或 npm 包内容变化的新版本时，源码冻结后统一升一次 `packages/turn-recorder-cli/package.json` version，同步 README/安装示例并执行 `check:cli-release`。
- 如果同一改动同时影响两个分发面，分别判断并分别升版本；两者无需强行相同。
- README 中的 CLI 安装版本必须与 CLI package 当前版本一致，避免复制陈旧命令。

开发目录包：

```bash
npm run pack:artifact
```

准备桌面 App 可安装版本或正式发布时，必须安装并检查同一产物：

```bash
npm run install:mac:dev
```

正式签名/公证安装：

```bash
npm run install:mac
```

正式路径要求 Developer ID Application/`CSC_LINK`、Team ID 与 Apple notarization credentials；安装器会验证 bundle id、App/CLI version、签名、Gatekeeper、staple 和 Team ID 后再原子替换 `/Applications/Scry.app`。不要手工覆盖 App。

独立 CLI 发布只使用：

```bash
npm run publish:cli
```

package lifecycle 会强制执行 `check:cli-release`；发布目标是执行者本机 npm 配置（或用 `--registry` 显式指定）的 registry，仓库不再固定任何部署方地址。不要从陈旧 `dist` 手工 `npm publish`。

提交前检查 `git diff`，只提交本任务改动；除非用户明确要求，不推送。
