# 批次 A 执行报告（待核验）

本页为历史报告索引。正文按实施、验证及后续修订拆分，原文和历史结论均保留；当前核验状态见[总状态](../STATUS.md)。

## 结论与提交

[查看本节所在记录](A-implementation.md)

## 旧实现上的失败证据

[查看本节所在记录](A-implementation.md)

### A1

[查看本节所在记录](A-implementation.md)

### A2

[查看本节所在记录](A-implementation.md)

### A3

[查看本节所在记录](A-implementation.md)

## 改动后的行为

[查看本节所在记录](A-implementation.md)

### A1：从静默 duplicate 到可查询 orphan

[查看本节所在记录](A-implementation.md)

### A2：跳过分支留痕与诊断

[查看本节所在记录](A-implementation.md)

### A3：持久化边界与 L1 计数

[查看本节所在记录](A-implementation.md)

## 验证与首次失败记录

[查看本节所在记录](A-verification.md)

## 用户验证：OpenCode / Qoder / Codex

[查看本节所在记录](A-verification.md)

### A-1 正常采集

[查看本节所在记录](A-verification.md)

### A-2 CLI 失效仍 fail open

[查看本节所在记录](A-verification.md)

### A-3 精确抑制开始事件，不靠手速切路径

[查看本节所在记录](A-verification.md)

### A-4 invalid_config 与恢复

[查看本节所在记录](A-verification.md)

## 未验证与留给用户决定的事

[查看本节所在记录](A-verification.md)

## 核验意见（审查方，2026-10-24）

[查看本节所在记录](A-verification.md)

### V1（需修改）A1：正常的会话结束和续跑 Stop 被计成 missing_start

[查看本节所在记录](A-verification.md)

### V2（接受）A1 orphan-only 范围

[查看本节所在记录](A-verification.md)

### V3（不阻塞，留给用户决定）A2：doctor 对历史 skip 永久报 error

[查看本节所在记录](A-verification.md)

### V4（记录）managed 分支从 `exec` 改为子进程

[查看本节所在记录](A-verification.md)

### 下一步

[查看本节所在记录](A-verification.md)

## V1 修改记录

[查看本节所在记录](A-v1.md)

### 四条要求的落实

[查看本节所在记录](A-v1.md)

### 其他 Provider 的确认依据与处理

[查看本节所在记录](A-v1.md)

### 旧实现失败输出与迭代记录

[查看本节所在记录](A-v1.md)

### 最终验证

[查看本节所在记录](A-v1.md)

### 核验交接与限制

[查看本节所在记录](A-v1.md)

## V1 核验意见（审查方，2026-10-25）

[查看本节所在记录](A-v1.md)

## V3 修改记录

[查看本节所在记录](A-v3.md)

### 旧实现失败输出

[查看本节所在记录](A-v3.md)

### 修复后验证

[查看本节所在记录](A-v3.md)

## 手验记录

[查看本节所在记录](A-provider-flow.md)

### 身份、隔离与原始命令

[查看本节所在记录](A-provider-flow.md)

### 逐项结论与运行偏差

[查看本节所在记录](A-provider-flow.md)

### 每一步的诊断原始字段

[查看本节所在记录](A-provider-evidence.md)

### 收尾、限制与留给用户决定的事

[查看本节所在记录](A-provider-evidence.md)

## V3 与手验核验意见（审查方，2026-10-25）

[查看本节所在记录](A-v3-review.md)

### V3

[查看本节所在记录](A-v3-review.md)

### 真实 Provider 手验

[查看本节所在记录](A-v3-review.md)

### OpenCode/Qoder：终态后 180 秒才落盘

[查看本节所在记录](A-v3-review.md)

### 状态

[查看本节所在记录](A-v3-review.md)
