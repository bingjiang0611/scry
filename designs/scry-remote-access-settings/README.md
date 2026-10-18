# Scry · 远程访问设置设计稿

状态：**A 已实现，安装受门禁阻碍**。用户选择精简 A 后说“没问题 落地吧”。原型不再是待选方向；正式 App 的最终验收仍需安装后由用户手动重启检查。

## 入口

- `preview.html`：推荐 A 的独立交互预览。当前版本已按用户反馈压缩默认文案：只保留名称、状态与动作；安全后果在对应弹窗显示。可切换默认、空列表、状态未知、待确认、中继休眠、手机未启用、多主机/长内容。连接、配对、吊销、邀请和复制都只是本地演示，不调用真实后端或剪贴板。
- `remote-access-settings.html`：A 分区单栏 / B 列表详情 / C 本机优先的信息结构对照。B、C 只表达结构，不作为完整能力实现。
- `brief.md`：需求、硬约束、调研、推荐与验证边界。

在仓库根目录预览（仅公开这个设计目录，不服务仓库或 HOME）：

```sh
python3 -m http.server 8946 --bind 127.0.0.1 --directory designs/scry-remote-access-settings
```

## 来源与制作

- 视觉 tokens 与字体映射：`src/renderer/styles.css`；独立原型冻结副本，不自动同步生产 tokens。
- 图标实际复用 `src/renderer/components/primitives/Icon.tsx`。
- 信息和操作语义沿用 `HostsView`、`RemotePairing`、`RemoteHostPanel`。原型不复用它们的请求代码，避免执行真实操作。
- 对照画布使用 design-loop 内置 `toolkit/baoyu/starter-components/design-canvas.jsx`，转换后放在 `design-canvas.js`。不改 toolkit。
- `vendor/` 为仓库已安装 React 18.3.1 / ReactDOM 18.3.1 UMD，保留其 license header。无需 CDN 或新依赖。
- `react-shim.js` / `react-dom-shim.js` 把编译后的原型绑定到同一个 UMD React，避免重复 React 实例。
- `copy.ts` 是本轮新增或改写文案的唯一来源；正式实现时迁移到项目文案模块，不在 JSX 复制字符串。

修改原型后，在仓库根目录使用已安装 esbuild 更新 bundle：

```sh
node_modules/.bin/esbuild designs/scry-remote-access-settings/prototype.tsx \
  --format=iife --bundle --jsx-factory=React.createElement --jsx-fragment=React.Fragment \
  --alias:react=./designs/scry-remote-access-settings/react-shim.js \
  --alias:react-dom/client=./designs/scry-remote-access-settings/react-dom-shim.js \
  --outfile=designs/scry-remote-access-settings/prototype.js
```

## 实际检查

- esbuild 编译成功。
- strict TypeScript 检查成功：

```sh
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --jsx react-jsx \
  --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop \
  --lib ES2022,DOM designs/scry-remote-access-settings/prototype.tsx \
  designs/scry-remote-access-settings/InteractivePreview.tsx
```

- 两个 HTML 的 loopback HTTP 请求返回成功。
- Chrome Relay：查看了推荐稿画面、文案精简后的默认画面、画布 A 画面、空列表、添加弹窗；点击展开主机后读回详情；状态未知读回明确错误且不显示计数；待确认切换曾 timeout，恢复原标签后只读核对，确认指纹与确认操作区域存在，没有重放该动作。
- 自审修正：主机身份左对齐；推荐稿移除重复说明与 rail 提示；高度跟随视口；不画可误认为能配对的假二维码。
- 后续截图请求遇到 Relay timeout，recover 仍 hello timeout。最终几处 CSS/文字减法没有新截图，不能宣称最终全场景视觉验收通过。手机、真实 SSH、真实配对、键盘焦点约束、真 App 均未验收。
- 独立视觉 reviewer 尝试受阻：浏览器截图返回 encrypted artifact，而不是可读本地文件；reviewer 没有读到截图，所以不算独立视觉评审通过。
- 本次条目已注册，`library.py search '统一远程访问' --kind page` 命中 D-20261018-scry-remote-access-settings。`build` 成功；全库 `check` 失败仅因原有 5 条失效来源（P-PI-MODEL-SELECTOR、D-20260912-scry-ios-remote、D-20261008-scry-ios-continuity、P-SCRY-SESSION-HISTORY、D-20261010-scry-llm-sidebar）；未删除这些指针。

## 下一步

生产实现已移除 sidebar 主机入口；位置菜单的管理入口直达设置；复用原有主机与配对 API。当前生产 renderer 的隔离 Electron 原生输入回归已通过，含草稿、焦点、嵌套弹窗与未知/休眠/关闭状态；故意改错入口的反向对照失败，证明回归可以发现接线错误。生产独立视觉评审已读取截图，具体建议及取舍见 `brief.md`。

当前全量测试和 Node 类型检查受现有 main/history WIP 阻碍，未执行安装。远程 smoke 曾在总预算处超时；将新增状态场景搬入同一门禁的专项模式后，完整远程 UI、会话 parity 和设置专项均通过。首次失败仍保留，详见 `brief.md`。待这些门禁问题处理后，按仓库流程构建安装；不自动重启正在运行的 App。由用户手动重启后确认实际布局与既有主机操作；真实手机/SSH 配对仍未验收。历史“实际检查”段落记录的是设计稿阶段，不代表生产验收。
