import { experimentalAnalyze, parse } from "workerd-oxc";
import type {
  CodemodeValidationIssue,
  CodemodeValidationResult,
  CodeValidationContext,
  CodemodeValidator
} from "../validation";
import type { ConnectorDescription } from "../connectors";
import { AMBIENT_SANDBOX_GLOBALS, BUILTIN_PROVIDER_GLOBALS } from "./globals";

export type SemanticValidatorOptions = {
  /** Name reported on diagnostics. Defaults to `"semantic"`. */
  name?: string;
  /**
   * Extra identifiers that are injected into the sandbox scope beyond the
   * configured connectors and the built-in `codemode` provider — for example
   * the names of custom providers registered on the runtime. Without these,
   * references to them would be reported as unknown connectors.
   */
  allowedGlobals?: readonly string[];
  /**
   * Also reject calls to methods that do not exist on a configured connector
   * (e.g. `github.no_such_method()`). Defaults to `true`. Connectors whose
   * descriptors are empty are skipped (their method set is unknown).
   */
  checkMethods?: boolean;
  /** Maximum number of issues to report. Defaults to 10. */
  maxIssues?: number;
};

const DEFAULT_MAX_ISSUES = 10;

/**
 * A code validator that rejects generated programs which cannot succeed at
 * runtime because they reference things that do not exist:
 *
 * - **Unknown connectors** — a bare identifier that is neither a configured
 *   connector, the built-in `codemode` provider, nor an ambient global. Such
 *   code throws `X is not defined` the moment it runs.
 * - **Unknown methods** (opt-out) — a call to a method that a configured
 *   connector does not expose.
 *
 * Both classes of error parse fine but waste a dynamic Worker execution, so
 * catching them here saves that cost. Detection uses the Oxc semantic analyzer
 * and parser compiled to WebAssembly (`workerd-oxc`).
 */
export function semanticValidator(
  options: SemanticValidatorOptions = {}
): CodemodeValidator {
  const name = options.name ?? "semantic";
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const extraGlobals = options.allowedGlobals ?? [];
  const checkMethods = options.checkMethods ?? true;

  return {
    name,
    async validateCode(
      context: CodeValidationContext
    ): Promise<CodemodeValidationResult> {
      const analyzed = await experimentalAnalyze({
        filename: "codemode.js",
        source: context.normalizedCode,
        lang: "js"
      });

      // If analysis could not run (e.g. the program does not parse), defer to
      // the syntax validator rather than reporting a misleading semantic error.
      if (!analyzed.ok) return { valid: true };

      const connectorNames = context.connectors.map((c) => c.name);
      const allowed = new Set<string>([
        ...AMBIENT_SANDBOX_GLOBALS,
        ...BUILTIN_PROVIDER_GLOBALS,
        ...extraGlobals,
        ...connectorNames
      ]);

      const issues: CodemodeValidationIssue[] = [];
      const reported = new Set<string>();

      // L2A: unknown connectors / undefined variables.
      for (const ref of analyzed.value.unresolved) {
        if (allowed.has(ref.name)) continue;
        if (reported.has(ref.name)) continue;
        reported.add(ref.name);
        if (issues.length >= maxIssues) break;
        issues.push(unknownConnectorIssue(ref, connectorNames, context));
      }

      // L2B: calls to methods a configured connector does not expose.
      if (checkMethods && issues.length < maxIssues) {
        // Only method-check identifiers that are genuinely the injected
        // connector global. A connector name shadowed by a local binding is a
        // *resolved* reference, so it never appears in `unresolved` and its
        // offset is absent here — which keeps L2B from flagging locals.
        const connectorNameSet = new Set(connectorNames);
        const connectorGlobalOffsets = new Set<number>();
        for (const ref of analyzed.value.unresolved) {
          if (connectorNameSet.has(ref.name) && ref.span) {
            connectorGlobalOffsets.add(ref.span.start);
          }
        }

        const methodIssues = await findUnknownMethodCalls(
          context,
          context.connectors,
          maxIssues - issues.length,
          connectorGlobalOffsets
        );
        issues.push(...methodIssues);
      }

      return issues.length > 0 ? { valid: false, issues } : { valid: true };
    }
  };
}

function unknownConnectorIssue(
  ref: { name: string; span?: { start: number; end: number } },
  connectorNames: readonly string[],
  context: CodeValidationContext
): CodemodeValidationIssue {
  const available =
    connectorNames.length > 0
      ? `Available connectors: ${connectorNames.join(", ")}.`
      : "No connectors are configured.";
  const path = ref.span
    ? formatLocation(context.normalizedCode, ref.span.start)
    : undefined;
  return {
    message: `"${ref.name}" is not an available connector or defined variable.`,
    code: "unknown-connector",
    suggestion: available,
    ...(path ? { path } : {})
  };
}

// ---------------------------------------------------------------------------
// L2B — unknown method calls
// ---------------------------------------------------------------------------

type AstNode = { type?: string; [key: string]: unknown };

async function findUnknownMethodCalls(
  context: CodeValidationContext,
  connectors: readonly ConnectorDescription[],
  budget: number,
  connectorGlobalOffsets: ReadonlySet<number>
): Promise<CodemodeValidationIssue[]> {
  const parsed = await parse({
    filename: "codemode.js",
    source: context.normalizedCode,
    lang: "js"
  });
  if (!parsed.ok) return [];

  // Only check connectors whose method set is actually known.
  const methodsByConnector = new Map<string, Set<string>>();
  for (const c of connectors) {
    const methods = Object.keys(c.descriptors);
    if (methods.length > 0) methodsByConnector.set(c.name, new Set(methods));
  }
  if (methodsByConnector.size === 0) return [];

  const issues: CodemodeValidationIssue[] = [];
  const reported = new Set<string>();

  const visit = (node: unknown): void => {
    if (issues.length >= budget) return;
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as AstNode;

    if (n.type === "CallExpression") {
      const callee = n.callee as AstNode | undefined;
      if (callee?.type === "MemberExpression") {
        const call = readConnectorMethodCall(callee);
        // Skip unless this exact identifier is the injected connector global
        // (present in the unresolved set), so a shadowing local is never
        // method-checked against the connector's descriptors.
        if (
          call &&
          call.objectOffset !== undefined &&
          connectorGlobalOffsets.has(call.objectOffset)
        ) {
          const methods = methodsByConnector.get(call.connector);
          const key = `${call.connector}.${call.method}`;
          if (methods && !methods.has(call.method) && !reported.has(key)) {
            reported.add(key);
            if (issues.length < budget) {
              issues.push(unknownMethodIssue(call, methods, context));
            }
          }
        }
      }
    }

    for (const key of Object.keys(n)) {
      if (key === "type") continue;
      visit(n[key]);
    }
  };

  visit(parsed.value.ast);
  return issues;
}

type MethodCall = {
  connector: string;
  method: string;
  /** Start offset of the method identifier/literal, for diagnostics. */
  offset?: number;
  /** Start offset of the object identifier, used to confirm it is the global. */
  objectOffset?: number;
};

/**
 * Read a `<connector>.<method>` or `<connector>["<method>"]` member expression.
 * Returns `undefined` for anything dynamic or nested that cannot be checked
 * statically, so the validator stays conservative and avoids false positives.
 */
function readConnectorMethodCall(member: AstNode): MethodCall | undefined {
  const object = member.object as AstNode | undefined;
  if (object?.type !== "Identifier") return undefined;
  const connector = object.name;
  if (typeof connector !== "string") return undefined;
  const objectOffset = numberOrUndefined(object.start);

  const property = member.property as AstNode | undefined;
  const computed = member.computed === true;

  if (!computed && property?.type === "Identifier") {
    const method = property.name;
    if (typeof method !== "string") return undefined;
    return {
      connector,
      method,
      offset: numberOrUndefined(property.start),
      objectOffset
    };
  }

  if (computed && property?.type === "Literal") {
    const value = property.value;
    if (typeof value !== "string") return undefined;
    return {
      connector,
      method: value,
      offset: numberOrUndefined(property.start),
      objectOffset
    };
  }

  return undefined;
}

function unknownMethodIssue(
  call: MethodCall,
  methods: ReadonlySet<string>,
  context: CodeValidationContext
): CodemodeValidationIssue {
  const available = [...methods].sort();
  const path =
    call.offset !== undefined
      ? formatLocation(context.normalizedCode, call.offset)
      : undefined;
  return {
    message: `"${call.method}" is not a method on connector "${call.connector}".`,
    code: "unknown-method",
    suggestion: `Available methods on "${call.connector}": ${available.join(", ")}.`,
    ...(path ? { path } : {})
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Convert a UTF-16 string offset into a 1-based `line:column` label for
 * diagnostics. `experimentalAnalyze` and the parser report string offsets.
 */
function formatLocation(source: string, offset: number): string {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return `${line}:${column}`;
}
