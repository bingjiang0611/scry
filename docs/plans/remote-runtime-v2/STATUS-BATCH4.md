# Batch 4 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH4.md](EXECUTION-BATCH4.md)；起点 `66225f1`（Batch 3 收尾）。
工作约定、停止条件、提交与 STATUS 规则沿用 [EXECUTION.md](EXECUTION.md) 第 0、1 节。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B4-F1 renderer UI 门禁 | 完成 | `见 status` | [b4-f1](status/b4-f1.md)：失败原因是 fixture 控件条自身吞掉点击，非产品遮挡；`test:renderer:ui` 已全绿 |
| B4-F2 supervisor 余项 | 未开始 | — | 确定性启动失败映射为不重试退出码；reason 接受 `remote_` 前缀 |
| B4-F3 macOS 兜底收窄 | 未开始 | — | 可识别的 UTC `lstart` 记录在 macOS 上视为精确身份 |
| B4-D 设计补全 | 未开始 | — | P3 §13 IPC 矩阵（脚本生成 + 测试守住）、P3b §8 进度表 |
| B4-L1 本机入网与 `scope: local` | 未开始 | — | B4-D 核验通过后才开始 |
| B4-L2 main 侧 daemon 客户端与 supervisor | 未开始 | — | |
| B4-L3 run 经 daemon | 未开始 | — | |
| B4-L4 其余能力经 daemon | 未开始 | — | |
| B4-S 切换与删除 | 未开始 | — | |
| B4-V 验收 | 未开始 | — | |

## 执行顺序

1. **B4-F1 → F2 → F3**：每项先写失败测试、单独提交；每段通过门禁后更新本文件并推送。
2. **B4-D**：只写文档，完成后停下等维护者确认第 2 条（本机入网与授权语义）与第 4 条（trace 推送方式与延迟预算）。
3. B4-L1 及之后不在本轮范围；未获核验前不开始。

## 阻塞

无。

## 需要决定

无（B4-D 完成后会新增两项待确认：本机入网 `scope: local` 授权语义、trace 推送方式与延迟预算）。