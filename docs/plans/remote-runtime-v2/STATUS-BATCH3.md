# Batch 3 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH3.md](EXECUTION-BATCH3.md)；核验结论：[REVIEW-BATCH2.md](REVIEW-BATCH2.md)。
起点 `577995b`。

## 总览

| 任务 | 状态 | 提交 | 说明 |
|---|---|---|---|
| B3-F1 trace 尾沿补读 | 完成 | `见下` | [b3-f1](status/b3-f1.md)：尾沿 + 跟随 run 按窗口读；L1 仍 60/min；另加 security smoke 产物版本闸门 |
| B3-F2 Mac run 绑定发信号 | 完成 | `b95e47f` | [b3-f2](status/b3-f2.md) |
| B3-D 设计稿三处更正 | 完成 | `见下` | [b3-d](status/b3-d.md)：§7 凭据如实拆分、新增 §8.1 daemon 运行时、§11 删除共存版本项、§8 加进度表 |
| B3-M1 前置 db.ts 拆分（纯搬移） | 完成 | `见下` | [b3-m1-split](status/b3-m1-split.md)：8 个模块，全部 < 20 KB，`db.ts` 只做 re-export；调用方与逻辑不变 |
| B3-M1 存储注入化 | 完成 | `见下` | [b3-m1](status/b3-m1.md)：`storage-paths` 注入，db 各子模块与 `remote-history` 不再要 electron；导入图测试先失败后通过 |
| B3-M2 运行管线去 Electron 化 | **未开始** | — | |
| B3-P1 daemon 承载宿主 | **未开始** | — | |
| B3-V1 security smoke 归属 | 完成（结论：非回归，调用方式错误） | `见下` | [b3-v1](status/b3-v1.md)：无 `--dev` 时脚本跑的是 0.2.220 旧产物，源码 0.2.237；`--dev` 下起点与当前 HEAD 均通过 |
| 交付前全局验证 | **未执行** | — | |

## 剩余任务的执行顺序（不得跳序）

1. **B3-M1** → **B3-M2** → **B3-P1** —— 严格串行。
3. 交付前全局验证 + `npm run test:renderer:ui`。

## 阻塞

无。`db.ts` 超过提交门禁的问题已按门禁要求先做纯搬移拆分（`01bca85f`），M1 随后落到子模块。

M1 之后的 M2 依赖面（本步没有改变，留给 M2 处理）：`trace-runtime.ts`、`run-*.ts`、`conversation.ts`、`app-agent.ts`、`agent-runner.ts`、`source-control`、`desktop-workbench` 里对 `app` / `BrowserWindow` / `webContents` 的依赖尚未注入。

## 需要决定

无。

## 既有问题（本批未处理）

`src/main/source-control/workspace-choices.test.ts › paginates bounded refs…` 在整批并行跑时偶发 5 s 超时，单跑通过。属既有并行负载脆弱点，与本批改动无关；没有放宽超时或跳过。详见 [b3-m1-split](status/b3-m1-split.md)。
