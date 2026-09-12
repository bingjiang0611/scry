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
- 没有 iOS 实机截图、SwiftUI 组件、经过用户批准的移动端品牌图标可用；因此本稿使用 CSS / inline SVG 的本地合成界面和合成 `icon.png`，没有复制私人截图。
- 未使用外部图片、CDN、远程字体或运行时网络资源；HTML 可在本地 HTTP 预览。
- `design-loop` 库检索 `Scry iOS Remote` 无命中；旧历史线索仅作上下文，不当作当前认可。

## 研究边界

本轮未安装或操作 T3/Codex 等竞品，没有配对手机、推送、蜂窝网络、真实 Mac 锁屏、Provider、账户或终端；参考资料中的技术可行性仍需后续 G0/G4 真机与安全验收。研究与界面数据均为合成示例。
