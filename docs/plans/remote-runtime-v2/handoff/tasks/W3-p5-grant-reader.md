# W3 · P5-5a 剩余：grant 读取端兼容 `approvedVia`（发布 1）

## 目标

P5 决定把「批准方式」写进设备 grant，分两次发布：这次只让读取端**认识**新字段 `approvedVia`，不写它。这样下一个发布开始写入后，回退一个版本仍能读配对状态。

依据：[P5-headless-host](../../P5-headless-host.md) §10.1 第 4 条、[P5-host-cli](../../P5-host-cli.md) §3.7、[P5-host-security](../../P5-host-security.md) §7（P5-5a 行）。先例：`scope` 字段的只向前兼容（`src/main/remote/pairing-state.ts` 中的校验）。

## 范围

- `src/main/remote/pairing-state.ts`：严格校验接受 grant 上可选的 `approvedVia`，取值只限 `'app' | 'host_cli'`，且只出现在 `scope: remote` 的 grant 上（[P5-host-cli](../../P5-host-cli.md) §3.7 第 75 行）；其他取值或出现在 local grant 上仍拒绝；缺省时语义是「未记录」。
- 不写入、不在界面显示（那是 P5-7）。
- 配对清理（`pairing-retention.ts`）保持子集语义：带新字段的 grant 照样能被清理且不丢字段。

## 验收与自验

| # | 标准 |
|---|---|
| 1 | 失败测试先行：带 `approvedVia` 的状态文件今天被拒绝 → 修复后被接受；非法取值仍拒绝；不带字段的旧文件不变 |
| 2 | 往返：读入再写出，字段原样保留，文件仍能被旧逻辑以外的字段校验通过 |
| 3 | daemon 模式：`src/daemon/host-process-pairing.test.ts` 加一条，带新字段的状态下 daemon 正常启动、App 正常入网 |
| 4 | `npx vitest run src/main/remote/pairing src/daemon/host-process-pairing`、`npx tsc --noEmit -p tsconfig.node.json` 通过 |

## 报告

`reports/W3.md`。小任务，可在 W1 等待期间做。
