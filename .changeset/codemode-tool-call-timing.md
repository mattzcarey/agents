---
"@cloudflare/codemode": patch
---

Include per-tool-call timing in codemode execution results. `ExecuteResult`, code tool outputs, and browser code tool outputs now expose `toolCalls` entries with the provider, tool name, args, and `durationMs` for each sandbox tool call.
