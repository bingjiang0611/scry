## 交付前的测试要求

- 改了生产代码：受影响测试 + `npm run typecheck`；提交前 `npm run test:unit` 全量。
- 改了界面：再加 `npm run test:renderer:ui` 和真实 App 重放（项目 AGENTS.md 要求），截图/真机不可用时写“未验证”。
- 改了计数或台账：`npx vitest run scripts/performance-ratchet.test.ts` 和对应 collector；`performance-ratchet.mjs guard <旧台账> <新台账>` 必须通过。
- **已知的原有失败**（不是你造成的，也不要“修”它们来变绿，只需报告是否仍然存在）：高负载下 `src/main/source-control/service.test.ts` 的 push endpoint / PR recheck 用例、`src/renderer/remote-workbench.test.ts` 的 source-control 用例会 5 秒超时；同一用例在 main `1c30b76` 上同样失败；负载约 200 时 `src/main/providers/pi.test.ts` 的 “menu-only command” 用例出现过一次断言失败，单独重跑改动前后均通过。若出现新的失败，按自己的问题处理。
