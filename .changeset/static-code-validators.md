---
"@cloudflare/codemode": minor
---

Add built-in static code validators: `syntaxValidator` and `semanticValidator`. These plug into the pluggable runtime validator API and reject model-generated code that cannot succeed — invalid JavaScript, references to unconfigured connectors, and calls to methods a connector does not expose — before a dynamic Worker execution is created. Detection uses the Oxc parser and semantic analyzer compiled to WebAssembly (`workerd-oxc`), so it runs inside the Workers runtime. Rejections return model-actionable diagnostics with source locations and suggestions.
