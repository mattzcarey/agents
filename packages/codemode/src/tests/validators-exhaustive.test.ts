import { describe, expect, it } from "vitest";
import type { ConnectorDescription } from "../connectors";
import type { CodeValidationContext } from "../validation";
import { syntaxValidator } from "../validators/syntax";
import { semanticValidator } from "../validators/semantic";

function connector(
  name: string,
  methods: readonly string[] = []
): ConnectorDescription {
  const descriptors: ConnectorDescription["descriptors"] = {};
  for (const method of methods) {
    descriptors[method] = { inputSchema: { type: "object" } };
  }
  return { name, descriptors };
}

function ctx(
  code: string,
  connectors: readonly ConnectorDescription[] = []
): CodeValidationContext {
  return { code, normalizedCode: code, connectors };
}

const syntax = syntaxValidator();
const semantic = semanticValidator();

async function syntaxValid(code: string): Promise<boolean> {
  return (await syntax.validateCode!(ctx(code))).valid;
}
async function semanticResult(
  code: string,
  connectors: readonly ConnectorDescription[] = []
) {
  return semantic.validateCode!(ctx(code, connectors));
}

// ---------------------------------------------------------------------------
// L1 — syntax: valid JavaScript that must be accepted
// ---------------------------------------------------------------------------

describe("L1 accepts valid JavaScript", () => {
  const valid: Record<string, string> = {
    arrow: `async () => 1`,
    "block body": `async () => { return 1; }`,
    "object destructuring": `async () => { const { a, b } = { a: 1, b: 2 }; return a + b; }`,
    "array destructuring": `async () => { const [x, y] = [1, 2]; return x + y; }`,
    "default + rest params": `async () => { const f = (a = 1, ...rest) => a + rest.length; return f(); }`,
    "spread call": `async () => Math.max(...[1, 2, 3])`,
    "template literal": "async () => `value ${1 + 1}`",
    "tagged template": "async () => String.raw`a${1}b`",
    "regex literal": `async () => "abc".replace(/a/g, "x")`,
    "optional chaining": `async () => { const o = {}; return o?.a?.b ?? 0; }`,
    "nullish + logical": `async () => { const x = 0; return x || 1 && 2; }`,
    "for-of": `async () => { let s = 0; for (const n of [1, 2]) s += n; return s; }`,
    "for-await": `async () => { let s = 0; for await (const n of []) s += n; return s; }`,
    "try/catch/finally": `async () => { try { return 1; } catch (e) { return 0; } finally {} }`,
    "nested functions": `async () => { function g() { return 2; } return g(); }`,
    IIFE: `async () => { return (function () { return 3; })(); }`,
    "class expression": `async () => { const C = class { m() { return 4; } }; return new C().m(); }`,
    "async inner + await": `async () => { const p = async () => 5; return await p(); }`,
    comments: `async () => {\n  // line comment\n  /* block */\n  return 1;\n}`,
    "JSON round-trip": `async () => JSON.parse(JSON.stringify({ a: 1 }))`,
    "ternary + chained": `async () => [1, 2, 3].filter((x) => x > 1).map((x) => x * 2)`,
    "bigint + numeric sep": `async () => 1_000n + 2n`
  };
  for (const [label, code] of Object.entries(valid)) {
    it(label, async () => {
      expect(await syntaxValid(code)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// L1 — syntax: broken or TS-only code that must be rejected
// ---------------------------------------------------------------------------

describe("L1 rejects invalid / non-runnable code", () => {
  const invalid: Record<string, string> = {
    "unclosed brace": `async () => { return 1;`,
    "unclosed paren": `async () => { return items.list( }`,
    "unclosed bracket": `async () => { const a = [1, 2; return a; }`,
    "stray token": `async () => { const 1x = 5; return 1x; }`,
    "dangling operator": `async () => { return 1 + ; }`,
    "double keyword": `async () => { const const x = 1; }`,
    "TS type annotation": `async () => { const n: number = 1; return n; }`,
    "TS param annotation": `async () => { const f = (a: string) => a; return f("x"); }`,
    "TS as-cast": `async () => { const x = (1 as unknown); return x; }`,
    "TS interface": `interface Foo { a: number }`,
    "TS enum": `enum E { A, B }`,
    "TS type alias": `type X = number;`
  };
  for (const [label, code] of Object.entries(invalid)) {
    it(label, async () => {
      expect(await syntaxValid(code)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// L2A — no false positives: locals, params, ambient globals must NOT be flagged
// ---------------------------------------------------------------------------

describe("L2A does not flag locally-bound names", () => {
  const bound: Record<string, string> = {
    const: `async () => { const x = 1; return x; }`,
    "let/var": `async () => { let a = 1; var b = 2; return a + b; }`,
    "arrow param": `async () => { const f = (p) => p + 1; return f(1); }`,
    "object destructuring": `async () => { const { data } = { data: 1 }; return data; }`,
    "array destructuring": `async () => { const [head] = [1, 2]; return head; }`,
    "rest param": `async () => { const f = (...xs) => xs.length; return f(1, 2); }`,
    "for-of binding": `async () => { for (const item of [1]) { void item; } return 1; }`,
    "for-let binding": `async () => { for (let i = 0; i < 1; i++) { void i; } return 1; }`,
    "catch binding": `async () => { try { return 1; } catch (err) { return err; } }`,
    "function decl name": `async () => { function helper() { return 1; } return helper(); }`,
    "nested arrow closure": `async () => { const outer = 1; const g = () => outer; return g(); }`,
    "class binding": `async () => { class C {} return new C(); }`
  };
  for (const [label, code] of Object.entries(bound)) {
    it(label, async () => {
      expect((await semanticResult(code)).valid).toBe(true);
    });
  }
});

describe("L2A does not flag ambient globals", () => {
  const globals = [
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "BigInt",
    "Math",
    "JSON",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "Promise",
    "Error",
    "TypeError",
    "Reflect",
    "Proxy",
    "Intl",
    "parseInt",
    "parseFloat",
    "isNaN",
    "encodeURIComponent",
    "structuredClone",
    "console",
    "fetch",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    "atob",
    "btoa",
    "crypto",
    "setTimeout",
    "queueMicrotask",
    "AbortController",
    "Headers",
    "Request",
    "Response"
  ];
  for (const g of globals) {
    it(g, async () => {
      const code = `async () => { return typeof ${g}; }`;
      expect((await semanticResult(code)).valid).toBe(true);
    });
  }
});

describe("L2A allows codemode provider and custom providers", () => {
  it("built-in codemode provider", async () => {
    expect(
      (await semanticResult(`async () => codemode.search("x")`)).valid
    ).toBe(true);
  });
  it("custom provider via allowedGlobals", async () => {
    const v = semanticValidator({ allowedGlobals: ["myapp", "db"] });
    const r = await v.validateCode!(
      ctx(`async () => { await db.query(); return myapp.run(); }`)
    );
    expect(r.valid).toBe(true);
  });
});

describe("L2A does not flag a connector name shadowed by a local", () => {
  it("local const shadows connector name", async () => {
    // `github` here is a local object, not the connector; must not be flagged.
    const r = await semanticResult(
      `async () => { const github = { x: 1 }; return github.x; }`,
      [connector("github", ["list_issues"])]
    );
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L2A — true positives: unknown connectors / undefined variables
// ---------------------------------------------------------------------------

describe("L2A flags unknown connectors", () => {
  it("top-level unknown", async () => {
    const r = await semanticResult(`async () => slack.post({})`, [
      connector("github")
    ]);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.issues![0].code).toBe("unknown-connector");
  });
  it("unknown used in a nested scope", async () => {
    const r = await semanticResult(
      `async () => { const f = () => notreal.go(); return f(); }`,
      [connector("github")]
    );
    expect(r.valid).toBe(false);
  });
  it("reports multiple distinct unknowns", async () => {
    const r = await semanticResult(
      `async () => { await a.x(); await b.y(); return c.z(); }`,
      []
    );
    expect(r.valid).toBe(false);
    if (r.valid) return;
    const names = new Set(
      r.issues!.map((i) => i.message.match(/"(\w+)"/)?.[1])
    );
    expect(names).toEqual(new Set(["a", "b", "c"]));
  });
});

// ---------------------------------------------------------------------------
// L2B — true positives and conservative skips for method checking
// ---------------------------------------------------------------------------

describe("L2B flags unknown methods on known connectors", () => {
  it("direct member call", async () => {
    const r = await semanticResult(`async () => github.nope()`, [
      connector("github", ["list_issues"])
    ]);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.issues![0].code).toBe("unknown-method");
  });
  it("computed string-literal call", async () => {
    const r = await semanticResult(`async () => github["nope"]()`, [
      connector("github", ["list_issues"])
    ]);
    expect(r.valid).toBe(false);
  });
  it("accepts a valid method", async () => {
    const r = await semanticResult(`async () => github.list_issues({})`, [
      connector("github", ["list_issues", "create_issue"])
    ]);
    expect(r.valid).toBe(true);
  });
  it("valid method reached via chaining", async () => {
    const r = await semanticResult(
      `async () => (await github.list_issues({})).map((x) => x)`,
      [connector("github", ["list_issues"])]
    );
    expect(r.valid).toBe(true);
  });
});

describe("L2B conservative skips (no false positives)", () => {
  it("dynamic computed access is not checked", async () => {
    const r = await semanticResult(
      `async () => { const m = "x"; return github[m](); }`,
      [connector("github", ["list_issues"])]
    );
    expect(r.valid).toBe(true);
  });
  it("empty-descriptor connector is skipped", async () => {
    const r = await semanticResult(`async () => github.anything()`, [
      connector("github")
    ]);
    expect(r.valid).toBe(true);
  });
  it("property read without a call is not checked", async () => {
    const r = await semanticResult(
      `async () => { const f = github.list_issues; return typeof f; }`,
      [connector("github", ["list_issues"])]
    );
    expect(r.valid).toBe(true);
  });
  it("method call on a local shadowing a connector name is not checked", async () => {
    // `github` is a local object here, not the connector — its `.foo()` must
    // not be validated against the connector's method list.
    const r = await semanticResult(
      `async () => { const github = { foo() { return 1; } }; return github.foo(); }`,
      [connector("github", ["list_issues"])]
    );
    expect(r.valid).toBe(true);
  });
  it("method call on a shadowing function parameter is not checked", async () => {
    const r = await semanticResult(
      `async () => { const run = (github) => github.whatever(); return run({ whatever: () => 1 }); }`,
      [connector("github", ["list_issues"])]
    );
    expect(r.valid).toBe(true);
  });
  it("flags the real connector global but not a same-named local shadow", async () => {
    // The nested `github` is a local shadow (its `.foo()` must be ignored); the
    // outer `github.bad_method()` is the real connector global and must fail.
    const code = `async () => {
      const helper = () => { const github = { foo() { return 1; } }; return github.foo(); };
      helper();
      return await github.bad_method();
    }`;
    const r = await semanticResult(code, [
      connector("github", ["list_issues"])
    ]);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.issues!).toHaveLength(1);
    expect(r.issues![0].code).toBe("unknown-method");
    expect(r.issues![0].message).toContain("bad_method");
  });
});

// ---------------------------------------------------------------------------
// Realistic end-to-end style programs
// ---------------------------------------------------------------------------

describe("realistic programs", () => {
  it("accepts a multi-step valid program", async () => {
    const code = `async () => {
      const issues = await github.list_issues({ repo: "agents" });
      const open = issues.filter((i) => i.state === "open");
      const titles = open.map((i) => i.title.toUpperCase());
      await items.create_item({ title: titles.join(", ") });
      return { count: open.length };
    }`;
    const r = await semanticResult(code, [
      connector("github", ["list_issues"]),
      connector("items", ["create_item", "list_items"])
    ]);
    expect(r.valid).toBe(true);
    expect(await syntaxValid(code)).toBe(true);
  });

  it("rejects a program mixing a good call and a bad method", async () => {
    const code = `async () => {
      const issues = await github.list_issues({ repo: "x" });
      return await items.frobnicate(issues);
    }`;
    const r = await semanticResult(code, [
      connector("github", ["list_issues"]),
      connector("items", ["create_item"])
    ]);
    expect(r.valid).toBe(false);
    if (r.valid) return;
    expect(r.issues!.some((i) => i.code === "unknown-method")).toBe(true);
  });
});
