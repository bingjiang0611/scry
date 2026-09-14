# Scry iOS Remote · Research notes

日期：2026-09-12
状态：需求合同已确认；本稿为 candidate / needs-review，未代表旧稿或本稿已获视觉认可。

## 实际查看过的参考

| 参考 | 实际动作 | 借鉴 | 明确不借鉴 |
|---|---|---|---|
| `designs/scry-composer-refresh/preview-v4.png` | 使用本地 `read` 查看整张预览 | 独立项目上下文、简洁层级、把 Provider / model / access 变成可辨识的次级控制 | 不复制桌面输入大框、中文业务文案或该稿布局；该版本当前为 `needs-review` |
| `designs/scry-ui-refresh/reference-current-light.png` | 使用本地 `read` 查看桌面旧截图 | 浅色底、细分割、克制蓝色操作色、会话与证据分组 | 不缩小三栏桌面、不复制 token 仪表盘、MCP/私人文本；截图是旧桌面参考，不是当前版本验收 |
| `designs/scry-ui-refresh/prototype.css` | 读取源码 tokens 与基础组件样式 | 低饱和浅色/深色正文/蓝绿琥珀状态的关系，`SF Pro` 系统字体方向 | 不导入设计系统；本目录保持独立候选 token |
| `docs/research/scry-ios-remote-research.md` | 读取用户范围、竞品事实、后台与安全语义章节 | 手机是 Mac 的控制端；锁屏醒着可用、睡眠/退出离线；APNs 仅作入口；Provider capability 显式 | 未把公开资料或竞品文字当作实操证据 |
| `docs/research/scry-ios-remote-technical-plan.md` | 读取协议、receipt、trust、文件、终端、生命周期章节 | `requested / confirmed / unknown` 分开；离线只读、写入禁用；设备与 fingerprint 分层 | 不宣称协议已实现，不使用真实 provider、host、账户或终端 |

## 未找到或未使用的图片/资源

- 没有可复用的已绑定 native design system；现有 Scry 设计目录的 `_d_meta.json` 均未绑定 DS。
- v1 制作时没有 iOS 实机参考图。v2 用户提供了三张 Codex iPhone 截图（见下）；没有本稿的实机截图、SwiftUI 组件或获批移动端品牌图标。继续使用本地 CSS / inline SVG / 合成 `icon.png`，不复制私人截图。
- 未使用外部图片、CDN、远程字体或运行时网络资源；HTML 可在本地 HTTP 预览。
- v1 初始检索无命中；v2 已命中并读取 `D-20260912-scry-ios-remote` 项目 brief，旧 A/B 结构不是本次认可。

## 研究边界

本轮未安装或操作 T3/Codex 等竞品，没有配对手机、推送、蜂窝网络、真实 Mac 锁屏、Provider、账户或终端；参考资料中的技术可行性仍需后续 G0/G4 真机与安全验收。界面数据均为合成示例。

## R-20260912-codex-ios · 用户指定的 v2 参考

三张图已通过 `read` 实际查看。仅作为项目参考，不形成“所有产品都采用 Codex”的全局规则。

| ID / 原始文件名 | 观察与采用 | 不采用 |
|---|---|---|
| R-CODEX-IOS-NEW / `pi-clipboard-ff1e6d93-915c-46f2-b05f-4463df2b7242.png` | 大面积留白，底部纵向主机/项目/位置/分支上下文，大圆角输入框及底部工具条 | 私人主机名、真实项目；不绘制截图中的 iOS 键盘/状态栏，不加入未支持的麦克风 |
| R-CODEX-IOS-HOME / `pi-clipboard-92cbe8b0-de9c-4a80-ac08-457f3cf640ff.png` | 居中远程标题＋主机副标题，圆形菜单/更多，无边框会话，项目内缩，悬浮搜索和新建 | 私人业务任务与链接；不照搬语音蓝按钮；不保留 v1 四 tab/卡片状态总览 |
| R-CODEX-IOS-CHAT / `pi-clipboard-90fce16c-79bc-4f81-b918-d49244a00fe9.png` | 紧凑头栏，近黑正文/淡灰代码块，弱化响应操作，底部文件和 Agent 胶囊＋输入条 | 私人业务分析和数字；不把 Codex 能力自动宣称为 Scry 支持 |

Uses：v2 的 `home()`、`newThread()`、`chat()`；详细页面用次级 sheet/导航承接 Scry 的能力。当前只确认借鉴方向，成品视觉待审。

参考 SHA-256（按新会话/首页/会话顺序）：
- `2cd98cdbe88c8d4033ff0a810822ce6279ce578169110616d45206537965fbb1`
- `0c706a0e9f24b4196c5b54e3efcea9a987ec208d21e9bf8b39fccf52ad5f69ad`
- `93e71f453fdc13e55205efb5d7742ed3d508302908c08b61c99de972871e3d4d`

隐私与缺口：原图位于用户提供的 macOS 临时目录，本次不持久复制进仓库或公开 gallery。这里只保存观察摘要和 hash；hash 不可恢复图像，临时文件失效时须重新取得参考，不能宣称已持久收藏原图。

## 2026-09-14 · v5 主流 iOS UI 调研

研究问题：在保持 Codex 式轻量会话体验的同时，如何改善 Scry 当前真机上的超大控件、无意义空白、项目上下文与运行证据之间的冲突？

查库结果：`library.py search "ScryRemote iOS remote pairing conversations run monitoring"` 无有效命中，并报告一个与本项目无关的 stale `P-PI-MODEL-SELECTOR`。因此直接读取本项目 v4、SwiftUI 源码及真机截图，并补充公开 App Store 实际截图。公开截图仅在浏览器查看，未复制进仓库。

| 参考 | 证据 | 可观察事实 | 本次借鉴 | 不借 / 限制 |
|---|---|---|---|---|
| R-CODEX-IOS（用户先前提供三图） | user-capture；本项目已有观察摘要与 hash | 顶部极简导航、正文主导、底部输入；新任务上下文靠近输入 | A 方向的结构基线 | 不复制私人内容、语音能力或品牌细节 |
| R-20260914-CHATGPT-IOS | OpenAI 官方 App Store 页面，2026-09-14 实际查看截图 | 对话页面几乎无卡片；用户内容用轻灰气泡；输入条高度克制，附件/语音围绕单一文本入口 | A/B 的正文比例、composer 密度和抽屉式历史 | 营销图不证明所有运行状态；不引入 Scry 未实现的语音/图片生成 |
| R-20260914-CLAUDE-IOS | Anthropic 官方 App Store 页面，2026-09-14 实际查看截图 | 顶部菜单与动作保持安静；大块内容画布，复杂结果以内容卡片承接 | B 的沉浸式会话与低 chrome | 页面多为营销场景且含照片，不作为导航行为证据 |
| R-20260914-GITHUB-IOS | GitHub 官方 App Store 页面，2026-09-14 实际查看截图 | Home/Inbox/Explore/Profile 底栏；列表行高紧凑；状态、数量和 diff 在任务语境中明确呈现 | C 的 Sessions/Runs/Devices 分区、审批/变更状态表达 | 不复制 GitHub 品牌色或把所有代码细节常驻在会话中 |
| 当前 Scry 真机 | `/tmp/scry-iphone-new.png`、`/tmp/scry-pair-final.png`，本轮实际查看 | 真实 iPhone 17 Pro 上上下文行与 composer 过大，中段空白；relay 域名直接成为用户主机名；通知会遮挡顶部内容 | 所有方向都压缩尺寸、使用友好主机标签、遵守安全区 | 临时截图不写入仓库；通知属于系统层，原型不伪造 |
| 当前 v4 原型 | `Scry iOS Remote v4.html`，本轮浏览器实际渲染 | Codex 骨架清楚，但置顶与项目重复、连接状态弱、未形成 Scry 特有的证据层 | A 从它演化，保留无边框与轻量层级 | 不延续重复列表和过多空白 |

结论：材料已覆盖聊天、任务列表/状态、移动导航和当前真机缺陷，停止扩展检索。三方向用相同任务内容比较：A 保留 Codex 无底栏，B 把聊天入口提前，C 用任务队列底栏增强控制性。动态键盘、推送跳转和系统通知遮挡仍需 SwiftUI 真机阶段验证。

### 用户追加的列表参考

- 来源：用户于 2026-09-14 提供的真机截图（临时路径 `pi-clipboard-2291a781-f951-4e0e-ade7-e1e483ef5b3a.png`，不复制进仓库）。
- 采用：`已置顶` 可折叠标题区；置顶条目只显示会话标题；`项目` 下以文件夹 + 项目名作为组头；项目组头右侧提供新建动作；组内会话缩进排列。
- 保留 Scry 约束：不复制截图中的语音按钮（当前产品无真实语音能力）；运行状态、置顶归属和项目内容均来自主机，不用示例数据填充生产界面。
