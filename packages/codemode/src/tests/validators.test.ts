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

function context(
  code: string,
  connectors: readonly ConnectorDescription[] = []
): CodeValidationContext {
  // Codemode normalizes to an async function; tests pass code already in that
  // shape so `normalizedCode` mirrors what the executor would run.
  return { code, normalizedCode: code, connectors };
}

describe("syntaxValidator", () => {
  const v = syntaxValidator();

  it("accepts valid JavaScript", async () => {
    const result = await v.validateCode!(
      context(`async () => { const x = 1; return x + 1; }`)
    );
    expect(result).toEqual({ valid: true });
  });

  it("rejects a syntax error with a location", async () => {
    const result = await v.validateCode!(
      context(`async () => {\n  const x = await items.list(\n  return x;\n}`)
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues?.length).toBeGreaterThan(0);
    const issue = result.issues![0];
    expect(issue.code).toBe("syntax-error");
    expect(issue.path).toMatch(/^\d+:\d+$/);
  });

  it("rejects TypeScript-only syntax by default (executor runs plain JS)", async () => {
    const result = await v.validateCode!(
      context(`async () => { const n: number = 1; return n; }`)
    );
    expect(result.valid).toBe(false);
  });

  it("accepts TypeScript when language is set to ts", async () => {
    const tsValidator = syntaxValidator({ language: "ts" });
    const result = await tsValidator.validateCode!(
      context(`async () => { const n: number = 1; return n; }`)
    );
    expect(result).toEqual({ valid: true });
  });
});

describe("semanticValidator (L2A: unknown connector)", () => {
  const v = semanticValidator();

  it("accepts references to configured connectors", async () => {
    const result = await v.validateCode!(
      context(
        `async () => { return await github.list_issues({ repo: "x" }); }`,
        [connector("github", ["list_issues"])]
      )
    );
    expect(result).toEqual({ valid: true });
  });

  it("rejects an unconfigured connector with a helpful suggestion", async () => {
    const result = await v.validateCode!(
      context(`async () => { return await slack.post({ text: "hi" }); }`, [
        connector("github")
      ])
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.issues![0];
    expect(issue.code).toBe("unknown-connector");
    expect(issue.message).toContain("slack");
    expect(issue.suggestion).toContain("github");
    expect(issue.path).toMatch(/^\d+:\d+$/);
  });

  it("does not flag ambient globals (JSON, Math, fetch, console)", async () => {
    const result = await v.validateCode!(
      context(
        `async () => {
          const a = JSON.stringify({});
          const b = Math.max(1, 2);
          const c = await fetch("https://example.com");
          console.log(a, b, c);
          return await items.read();
        }`,
        [connector("items", ["read"])]
      )
    );
    expect(result).toEqual({ valid: true });
  });

  it("does not flag the built-in codemode provider", async () => {
    const result = await v.validateCode!(
      context(`async () => { return await codemode.search("x"); }`, [])
    );
    expect(result).toEqual({ valid: true });
  });

  it("honors allowedGlobals for custom providers", async () => {
    const withProvider = semanticValidator({ allowedGlobals: ["myapp"] });
    const result = await withProvider.validateCode!(
      context(`async () => { return await myapp.doThing(); }`, [])
    );
    expect(result).toEqual({ valid: true });
  });

  it("reports each unknown name once", async () => {
    const result = await v.validateCode!(
      context(
        `async () => { await slack.a(); await slack.b(); return nope.c(); }`,
        []
      )
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const names = result.issues!.map((i) => i.message);
    expect(names.filter((m) => m.includes("slack"))).toHaveLength(1);
    expect(names.filter((m) => m.includes("nope"))).toHaveLength(1);
  });

  it("defers to the syntax validator when code does not parse", async () => {
    const result = await v.validateCode!(
      context(`async () => { const x = await items.list( }`, [
        connector("items")
      ])
    );
    expect(result).toEqual({ valid: true });
  });
});

describe("semanticValidator (L2B: unknown method)", () => {
  const v = semanticValidator();

  it("accepts a valid method on a configured connector", async () => {
    const result = await v.validateCode!(
      context(
        `async () => { return await github.list_issues({ repo: "x" }); }`,
        [connector("github", ["list_issues", "create_issue"])]
      )
    );
    expect(result).toEqual({ valid: true });
  });

  it("rejects a method the connector does not expose", async () => {
    const result = await v.validateCode!(
      context(`async () => { return await github.delete_universe({}); }`, [
        connector("github", ["list_issues", "create_issue"])
      ])
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.issues![0];
    expect(issue.code).toBe("unknown-method");
    expect(issue.message).toContain("delete_universe");
    expect(issue.message).toContain("github");
    expect(issue.suggestion).toContain("list_issues");
    expect(issue.path).toMatch(/^\d+:\d+$/);
  });

  it("checks computed string-literal member access", async () => {
    const result = await v.validateCode!(
      context(`async () => { return await github["nope"]({}); }`, [
        connector("github", ["list_issues"])
      ])
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues![0].code).toBe("unknown-method");
  });

  it("does not check methods on unknown connectors (L2A handles those)", async () => {
    const result = await v.validateCode!(
      context(`async () => { return await slack.anything(); }`, [
        connector("github", ["list_issues"])
      ])
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    // Only the unknown-connector issue, no unknown-method noise.
    expect(result.issues!.every((i) => i.code === "unknown-connector")).toBe(
      true
    );
  });

  it("skips connectors with no known methods (empty descriptors)", async () => {
    const result = await v.validateCode!(
      context(`async () => { return await github.anything(); }`, [
        connector("github")
      ])
    );
    expect(result).toEqual({ valid: true });
  });

  it("skips dynamic (non-literal computed) method access", async () => {
    const result = await v.validateCode!(
      context(`async () => { const m = "x"; return await github[m](); }`, [
        connector("github", ["list_issues"])
      ])
    );
    expect(result).toEqual({ valid: true });
  });

  it("can be disabled via checkMethods: false", async () => {
    const noMethods = semanticValidator({ checkMethods: false });
    const result = await noMethods.validateCode!(
      context(`async () => { return await github.delete_universe({}); }`, [
        connector("github", ["list_issues"])
      ])
    );
    expect(result).toEqual({ valid: true });
  });
});
