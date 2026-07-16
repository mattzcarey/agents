// Ambient globals available inside the codemode sandbox.
//
// `experimentalAnalyze` from workerd-oxc is a *per-file* analyzer: it has no
// knowledge of the ambient environment, so it reports every free identifier
// (including `JSON`, `Math`, `Promise`, `fetch`, ...) as "unresolved". The
// unknown-connector validator must therefore subtract a known set of ambient
// globals before deciding an identifier is a bad connector reference.
//
// The codemode executor runs generated code in a dynamic Worker with
// `nodejs_compat` (see `executor.ts`), so the ambient set is: standard
// ECMAScript globals + the Workers runtime globals + a small nodejs_compat
// surface. This list is intentionally curated (rather than pulling in the
// `globals` npm package) to avoid a new runtime dependency.

/** Standard ECMAScript language globals. */
const ECMASCRIPT_GLOBALS = [
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  "Float32Array",
  "Float64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "JSON",
  "Promise",
  "Proxy",
  "Reflect",
  "Intl",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  "escape",
  "unescape"
] as const;

/** Workers runtime (web-platform) globals available in the sandbox. */
const WORKERS_GLOBALS = [
  "console",
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "URL",
  "URLSearchParams",
  "URLPattern",
  "TextEncoder",
  "TextDecoder",
  "TextEncoderStream",
  "TextDecoderStream",
  "atob",
  "btoa",
  "crypto",
  "SubtleCrypto",
  "CryptoKey",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "structuredClone",
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "ReadableStream",
  "ReadableStreamDefaultReader",
  "WritableStream",
  "TransformStream",
  "CompressionStream",
  "DecompressionStream",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageChannel",
  "MessagePort",
  "WebSocket",
  "WebSocketPair",
  "caches",
  "navigator",
  "performance",
  "scheduler",
  "DOMException"
] as const;

/** Minimal nodejs_compat surface exposed as globals (not via `import`). */
const NODE_COMPAT_GLOBALS = ["Buffer", "process", "global"] as const;

/**
 * Names that are always in scope inside the codemode sandbox regardless of
 * which connectors are configured.
 */
export const AMBIENT_SANDBOX_GLOBALS: ReadonlySet<string> = new Set<string>([
  ...ECMASCRIPT_GLOBALS,
  ...WORKERS_GLOBALS,
  ...NODE_COMPAT_GLOBALS
]);

/**
 * The built-in non-connector provider namespace the codemode runtime always
 * injects (see `createPlatformProvider` in `proxy-tool.ts`). Applications that
 * register additional custom providers should pass their names via the
 * validator's `allowedGlobals` option.
 */
export const BUILTIN_PROVIDER_GLOBALS: readonly string[] = ["codemode"];
