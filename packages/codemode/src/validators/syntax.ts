import { parse } from "workerd-oxc";
import type {
  CodemodeValidationIssue,
  CodemodeValidationResult,
  CodeValidationContext,
  CodemodeValidator
} from "../validation";

export type SyntaxValidatorOptions = {
  /**
   * Name reported on diagnostics. Defaults to `"syntax"`.
   */
  name?: string;
  /**
   * Language to parse as. The codemode executor runs generated code as plain
   * JavaScript (it is inlined into a Worker module without a TypeScript strip
   * step), so TypeScript-only syntax fails at execution. Parsing as `"js"`
   * (the default) rejects that code before it reaches the executor. Set to
   * `"ts"` only if your executor transforms TypeScript first.
   */
  language?: "js" | "ts";
  /** Maximum number of syntax diagnostics to report. Defaults to 10. */
  maxIssues?: number;
};

const DEFAULT_MAX_ISSUES = 10;

/**
 * A code validator that rejects generated programs that are not parseable in
 * the language the executor runs. Catching syntax errors here avoids spinning
 * up a dynamic Worker isolate for code that can never execute.
 *
 * Uses the Oxc parser compiled to WebAssembly (`workerd-oxc`), so it runs
 * inside the same Workers runtime as the rest of the codemode runtime.
 */
export function syntaxValidator(
  options: SyntaxValidatorOptions = {}
): CodemodeValidator {
  const name = options.name ?? "syntax";
  const lang = options.language ?? "js";
  const filename = lang === "ts" ? "codemode.ts" : "codemode.js";
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;

  return {
    name,
    async validateCode(
      context: CodeValidationContext
    ): Promise<CodemodeValidationResult> {
      const parsed = await parse({
        filename,
        source: context.normalizedCode,
        lang
      });

      if (parsed.ok) return { valid: true };

      const issues: CodemodeValidationIssue[] = [];
      for (const diagnostic of parsed.diagnostics) {
        if (diagnostic.severity !== "error") continue;
        if (issues.length >= maxIssues) break;
        issues.push(toIssue(diagnostic));
      }

      // A failed parse with no error-severity diagnostic still must not pass.
      if (issues.length === 0) {
        issues.push({
          message: "The generated code is not valid JavaScript.",
          code: "syntax-error"
        });
      }

      return { valid: false, issues };
    }
  };
}

function toIssue(diagnostic: {
  message: string;
  location?: { line: number; column: number };
}): CodemodeValidationIssue {
  const path = diagnostic.location
    ? `${diagnostic.location.line}:${diagnostic.location.column}`
    : undefined;
  return {
    message: diagnostic.message,
    code: "syntax-error",
    ...(path ? { path } : {})
  };
}
