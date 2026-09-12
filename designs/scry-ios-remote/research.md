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
