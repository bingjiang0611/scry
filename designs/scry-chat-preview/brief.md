# Scry 会话图片预览与项目选择条

## D-chat-preview-containment

- 范围：Scry，局部修复；用户截图指出图片点击放大后遮罩/图片被会话区域裁切，右侧 Environment 面板盖住预览。
- 需求：首次打开完整适配视口，关闭按钮与缩放控制始终可见；放大后可滚动到图片边缘；关闭后恢复缩略图焦点。
- 实现：复用 `ChatTurn.tsx` 的 ImageLightbox 与 ModalFrame，将预览 portal 到 body，避开 `.transcript-turn` 的 content-visibility containment；保留长历史渲染优化。用图片自然尺寸与 stage 尺寸计算适配大小，缩放改变实际布局尺寸而非裁切 transform。
- 保留：Provider、附件数据来源、消息正文、右侧面板及安全边界；不更改全局 ModalFrame 挂载语义。

## D-composer-bound-project

- 用户反馈：“已经选定项目并开始对话的对话就不要用显示这个项目了”，截图定位为输入框顶部的 rate-native 项目选择条。
- 规则：已绑定项目且会话开始后隐藏整个 composer-context，不留下空栏；新建草稿和未绑定项目仍保留选择入口。顶部/侧栏项目标识不变。
- 覆盖启动提交但尚无 turn、运行中、已完成、归档加载和历史证据缺失；复用现有 turns、agentLocked、busy 等状态，不添加第二套会话身份。
- 状态：需求确认；成品待用户验收，不升级为跨项目设计偏好。

## 验证与限制

- `node scripts/chat-preview-ui-smoke.mjs`：隔离 sandboxed Electron，生产 React/CSS，合成横图/长图；1000×768、560×448 视口；遮罩覆盖、面板遮挡、适配、缩放边界与滚动、Esc/按钮/背景关闭、焦点恢复、重复打开重置、发送后项目条消失与新建恢复。隐藏窗口 focusin guard 使用合成事件，不冒充真实键盘验收。
- `npx vitest run src/renderer/components/render.test.tsx`：204 项通过，含项目选择条状态矩阵。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过；既有 session-capability UI smoke 通过。新增回归接入 `test:renderer:ui`。
- 当前已安装 Scry 正在运行；尝试启动开发版后进程退出，未强制结束现有实例。浏览器 relay 无可控标签，未在包含本次改动的真实 App 重放原始会话，不声称真实 App/用户验收通过。
- 查库未找到图片预览专用资产；复用生产组件做局部修复，无新独立组件资产。已有 Composer C4 原型未改动，项目条规则是其会话状态细化。
