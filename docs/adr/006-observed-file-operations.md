# 006: Report only observed file operations

**Status:** Accepted (documents existing behavior)

A file footprint describes observed operations, not every file the Provider touched. A tool's search pattern, free-form command, or mention of a path is not proof of a read or write.

Project known native read, write, and edit tools only when they supply an explicit path. Provider inputs use `file_path` or `path`; match tool names without case sensitivity. Do not infer file operations from shell or MCP payloads. [Issue #152](https://github.com/bingjiang0611/scry/issues/152) tracks structured evidence where the integration can actually supply it.

See [trace.ts](../../src/shared/trace.ts) and the [File Footprint glossary entry](../../GLOSSARY.md#证据与计量).
