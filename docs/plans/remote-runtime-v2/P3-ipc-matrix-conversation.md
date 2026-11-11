# P3 附录 · IPC 路由矩阵：统一对话（生成文件）

本文件由 `node scripts/daemon-ipc-matrix.mjs --write` 从源码生成，`scripts/daemon-ipc-matrix.test.ts` 在漂移时失败。不要手工编辑；改 `scripts/daemon-ipc-routing.json` 后重新生成。判定规则与其余 channel 见 [P3-ipc-matrix](P3-ipc-matrix.md)。

| channel | 去向 | op(method) | 用户路径 | 差异与分工 | 依据 |
|---|---|---|---|---|---|
| `conversation:adopt` | new-op | `conversation:adopt` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:create` | new-op | `conversation:create` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:createSideChat` | new-op | `conversation:createSideChat` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:delete` | new-op | `conversation:delete` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:findSideChatCommand` | new-op | `conversation:findSideChatCommand` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:fork` | new-op | `conversation:fork` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:list` | new-op | `conversation:list` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:listSideChats` | new-op | `conversation:listSideChats` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:preview` | new-op | `conversation:preview` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewAdoption` | new-op | `conversation:previewAdoption` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewDeletion` | new-op | `conversation:previewDeletion` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:previewSideChat` | new-op | `conversation:previewSideChat` | compose | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:read` | new-op | `conversation:read` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:readItem` | new-op | `conversation:readItem` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:readSideChatSnapshot` | new-op | `conversation:readSideChatSnapshot` | history | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:send` | new-op | `conversation:send` | send | — | 对话账本在 daemon 的 SQLite 里 |
| `conversation:update` | new-op | `conversation:update` | navigation | — | 对话账本在 daemon 的 SQLite 里 |
