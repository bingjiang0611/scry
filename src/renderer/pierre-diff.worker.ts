// Vite emits a local module worker and its assets; no CDN, eval or WASM permission is needed.
// Portable 入口自带打包产物，构建只产出一份 Shiki 语言分片，安装包比默认入口少约 10 MiB。
import '@pierre/diffs/worker/worker-portable.js'
