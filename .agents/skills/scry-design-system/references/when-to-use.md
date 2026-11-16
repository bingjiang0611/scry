# 使用场景与原始触发语义

维护 Scry 桌面 renderer 的设计系统与界面一致性。用于：新增或修改界面时选组件、写样式和文案；把手写的按钮、通知、标签页、菜单迁到共享实现；清理字号、字重、间距、颜色等设计债务；扩展 token 或 primitive 的方案讨论；`npm run design:audit` 或设计守卫测试失败时的处理；评审一个界面改动是否符合 DESIGN.md。

不用于：性能分析与优化（用 `scry-performance-climb`）；iOS 原生界面（SwiftUI，遵循 DESIGN.md 中的 iOS 约束但不走本流程）；产品功能逻辑、IPC、权限与证据语义；品牌、营销页面；PR 资格分诊（用 `contribution-triage`）。

只涉及界面但同时改动证据语义（`exact`、`estimated`、`unavailable` 等的展示）时，本 skill 负责样式与文案形态，证据含义按 AGENTS.md 的证据合同执行。
