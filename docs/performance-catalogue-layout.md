# 性能清单文件布局

[`scripts/performance-paths.json`](../scripts/performance-paths.json) 是组合清单。`pathFiles` 按顺序读取两份数据：

- [启动与发现](../scripts/performance-paths-discovery.json)：原有 startup/providers 路径。
- [交互与证据](../scripts/performance-paths-interactions.json)：原有后续十四条路径。

新增来源或 channel 时修改所属数据文件。组合清单只保留文件顺序、排除项和规则。`performance-catalogue.mjs` 的公开输出仍是 schema 1、十六条有序路径；拆分没有改变操作归类、指标、工作量或 ratchet。`performance-native.mjs` 的 harness 指纹包括组合清单、两份数据及加载器；缺少数据文件会拒绝加载，不回退为空清单。

`npm run performance:inventory` 检查组合后的引用和 IPC/trace 注册。基础规则见[持续性能闭环](performance-loop.md)。校验结果与未通过项见 [remaining map](../designs/scry-workflows/remaining-map-status.md)；文件拆分不是性能改善证据，也不表示完整 gate 已通过。
