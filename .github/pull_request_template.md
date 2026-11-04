<!-- Read CONTRIBUTING.md. Drafts follow the same requirements. One underlying problem per PR.
Use a conventional commit title. Do not upload credentials, private sessions or user databases. -->

## 问题

<!-- 预期、实际行为、复现步骤、系统 / Scry / 相关 Provider 或 CLI 版本。
涉及平台行为时，注明 CPU 架构和安装/运行方式；Linux 写明发行版及版本。
Linux UI/桌面问题补充桌面环境或窗口管理器及版本、Wayland/X11；容器、虚拟机或无头环境请明确标注。 -->

## 改动与范围

<!-- 如何解决问题；跨合同、main、renderer 或客户端的改动为什么必须一起进行。 -->

## 方向批准与风险边界

<!-- 链接已分诊 Issue / 维护者明确批准，或说明为何属于无需事前批准的小修复。
列出权限 / trust / IPC / 证据 / 持久化 / Provider / 性能门限 / 发布影响及所需决定。 -->

## 验证

<!-- 写具体 focused 命令或人工操作、观察结果和未验证项。
按 docs/agent/verification.md 选择范围：共享或平台边界改动分别记录 macOS/Linux 的实际检查和未验证原因；平台专属改动说明另一端为何不受影响。纯文档不增加平台验收。
Linux 构建/包检查不等于目标桌面验收；Xvfb/headless wlroots 结果不等于 Arch/Omarchy 会话结果。
UI 提供前后截图；交互时序需要时提供录屏。附件上传 GitHub，不提交 PR 专用素材。
手机编译不是实机验收，CI 不是付费 Provider 验收；不要只写“测试通过”。 -->

## Agent 使用

<!-- 若使用 Agent，注明模型与 harness；未使用可写“不适用”。 -->
