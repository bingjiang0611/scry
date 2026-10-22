# 执行协议（给实现 Agent）

## 角色

- **设计方**：写规格（`../brief.md`）与每步说明，核验每步推送。
- **执行方（你）**：在你自己的 macOS 环境里按步骤实现、验证、推送。

## 分支

- 唯一工作分支：`design/native-motion`（基于 `main` 的 `531e88c`）。
- 用户已明确授权：本任务的提交**推送到这个分支**。这覆盖 `CLAUDE.md`「默认不 push」的一般约定，仅限此分支；不推 `main`，不开 PR，不 force push。
- 开始每一步前先 `git pull --rebase origin design/native-motion`，设计方可能在上一步核验后追加了修正或说明。

## 每一步怎么做

1. 读 `../brief.md`（约束 H1–H6、token、原则）和本步的 `NN-*.md`。只做本步范围内的事；发现规格有问题或做不到，写进 `../progress.md` 的「问题」并停下，不要自行扩大或改写规格。
2. 实现。测量代码（新增的 performance 场景、fixture、smoke 断言）与实现代码**分开提交**，与 `CLAUDE.md`「不骗计数」一致。
3. 验证：按本步「验收」逐条执行，另按 `CLAUDE.md` 跑受影响的单测、`npm run typecheck:web`、`npm run build`。App 运行代码有改动时，用独立 `userData` 与临时工作区启动 test 实例做真实交互检查；通过后按 `CLAUDE.md` 执行 `npm run install:mac:dev`。
4. 在 `../progress.md` 追加本步记录（模板见该文件）：提交列表、改动摘要、每条验收的实际命令与结果、首轮失败、未验证项、与规格的偏差。
5. 提交信息格式：`motion(NN): <一句中文说明>`，例如 `motion(01): 引入动效 token 并去掉悬停抬升`。
6. 推送后**停下**，等待设计方核验。核验结论会以提交形式写回 `../progress.md` 的「核验」小节；结论为「通过」才开始下一步，「需修改」则先处理所列问题，用 `motion(NN-fix): …` 提交。

## 步骤

| 步骤 | 文件 | 范围 | 依赖 |
| --- | --- | --- | --- |
| 01 | `01-foundation.md` | token、减弱动效改淡化、去悬停抬升、标签指示条 | 无 |
| 02 | `02-structure.md` | View Transitions 封装；页面、会话、主题；面板与侧栏（先做性能实验） | 01 |
| 03 | `03-overlays.md` | `usePresence`；弹窗、菜单、悬停卡的入场与出场 | 01 |
| 04 | `04-lists.md` | `useFlipList`；列表首屏错开；折叠展开；流式新块入场 | 01 |
| 05 | `05-loading.md` | `useDelayedFlag`；会话等加载态延迟出现、改为细加载条 | 02 |
| 06 | `06-vibrancy.md` | 可选：侧栏 vibrancy | 01；需用户另行确认后才做 |

03 与 04 互不依赖，核验通过 02 后可按设计方指定的顺序进行。

## 不要做的事

- 不改 `../brief.md` 与本目录的步骤说明（有异议写到 `progress.md`）。
- 不顺手重构、格式化无关代码；不修与本任务无关的既有失败（单列报告即可）。
- 不手改 `scripts/performance-ratchet.json`。
- 不把截图、会话内容、用户数据提交进仓库。
