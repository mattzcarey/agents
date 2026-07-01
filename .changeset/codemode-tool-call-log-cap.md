---
"@cloudflare/codemode": patch
---

Cap codemode execution `toolCalls` logs at the 100 most recent entries and expose `droppedToolCallCount` when earlier entries are omitted.
