# 批次 C 执行报告

本页为历史报告索引。正文按实施、验证及后续修订拆分，原文和历史结论均保留；当前核验状态见[总状态](../STATUS.md)。

## 结论与提交

[查看本节所在记录](C-implementation.md)

## C1：失败回退与预算

[查看本节所在记录](C-implementation.md)

### 证实

[查看本节所在记录](C-implementation.md)

### 改动后的行为

[查看本节所在记录](C-implementation.md)

### 真实子进程计时与上限

[查看本节所在记录](C-implementation.md)

### 非 Claude Stop 与 180 秒附带确认（仅评估）

[查看本节所在记录](C-implementation.md)

## C2：实际 socket 路径

[查看本节所在记录](C-implementation.md)

## C3：子目录定位和存量 repair

[查看本节所在记录](C-implementation.md)

## 生效方式

[查看本节所在记录](C-implementation.md)

## 验证记录

[查看本节所在记录](C-verification.md)

## 用户验证

[查看本节所在记录](C-verification.md)

### C-U1：准备独立临时仓库

[查看本节所在记录](C-verification.md)

### C-U2：Codex 子目录的真实 cwd / 环境（C3 必测）

[查看本节所在记录](C-verification.md)

### C-U3：长路径与真实快路径（C2）

[查看本节所在记录](C-verification.md)

### C-U4：宽限期、回退痕迹与修复配置

[查看本节所在记录](C-verification.md)

## 未验证项与留给用户决定的事

[查看本节所在记录](C-verification.md)

## 核验意见（审查方，2026-10-25）

[查看本节所在记录](C-verification.md)

### 复跑

[查看本节所在记录](C-verification.md)

### VC1（必改）：daemon 崩溃或重启后留下的 socket 让所有事件只进 inbox、不再拉起 daemon

[查看本节所在记录](C-verification.md)

### VC2（建议，可与 VC1 一起做）：pointer 目标加属主检查

[查看本节所在记录](C-verification.md)

### C1 范围

[查看本节所在记录](C-verification.md)

### C2

[查看本节所在记录](C-verification.md)

### C3

[查看本节所在记录](C-verification.md)

### 状态

[查看本节所在记录](C-verification.md)

## VC1 修改记录

[查看本节所在记录](C-vc1.md)

### 失败证据与测试纠正

[查看本节所在记录](C-vc1.md)

### 实现

[查看本节所在记录](C-vc1.md)

### 当前构建的真实 CLI / daemon 探针

[查看本节所在记录](C-vc1.md)

### 验证结果与未通过项

[查看本节所在记录](C-vc1.md)

### 生效与用户验证

[查看本节所在记录](C-vc1.md)

## VC1 核验意见（审查方，2026-10-25）

[查看本节所在记录](C-vc1.md)
