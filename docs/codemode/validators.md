# Validators

Codemode validators let your application evaluate model-generated code before it runs. Validators are general host-side hooks: they can call a policy engine, run static analysis, ask a model to review the program, or apply application-specific rules.

Add validators to `createCodemodeRuntime`:

```ts
import {
  createCodemodeRuntime,
  type CodemodeValidator
} from "@cloudflare/codemode";

const policyValidator: CodemodeValidator = {
  name: "organization-policy",

  async validateCode({ code }) {
    const decision = await policyEngine.evaluate(code);

    return decision.allowed
      ? { valid: true }
      : {
          valid: false,
          issues: [
            {
              code: decision.code,
              message: decision.reason ?? "Rejected by organization policy."
            }
          ]
        };
  }
};

const runtime = createCodemodeRuntime({
  ctx: this.ctx,
  executor,
  connectors,
  validators: [policyValidator]
});
```

Validation is opt-in. With no validators configured, Codemode behaves as before. A validator that does not implement a particular hook does not participate at that validation point.

Every implemented hook must explicitly return `{ valid: true }` or `{ valid: false, issues? }`. Codemode fails closed if a configured hook returns nothing, returns malformed data, or throws. All participating validators must return valid before execution proceeds.

Codemode runs validators sequentially, collects issues from invalid results, and returns bounded, attributed feedback that the model can use to correct its code.

## Validate the generated program

`validateCode` runs before Codemode creates an execution or starts the executor. Its context contains:

- `code`: source exactly as the model supplied it;
- `normalizedCode`: source after Codemode strips fences and normalizes it to an async function;
- `connectors`: the configured connector descriptions, including methods and input schemas.

A validator can use as much or as little of this context as it needs:

```ts
const programValidator: CodemodeValidator = {
  name: "program-review",

  async validateCode({ code, normalizedCode, connectors }) {
    const issues = await reviewGeneratedProgram({
      request: currentUserRequest,
      code,
      normalizedCode,
      availableMethods: connectors
    });

    return issues.length > 0 ? { valid: false, issues } : { valid: true };
  }
};
```

An invalid result returns a `status: "error"` tool result with an empty execution ID. The executor does not start and the rejected program does not appear in the runtime's execution history.

If a program reviewer needs the original user request or messages, capture them in the validator closure when creating the runtime. Codemode does not prescribe a model or message representation for validators.

## Validate concrete connector calls

Use the optional `validateToolCall` hook when validation depends on evaluated arguments or current application state. It receives:

- `executionId`;
- connector and method names;
- concrete arguments;
- the method's input schema and annotations, when available.

For example, an application can reject a resource transition that is invalid for the resource's current state:

```ts
const lifecycleValidator: CodemodeValidator = {
  name: "resource-lifecycle",

  async validateToolCall({ connector, method, args }) {
    if (connector !== "resources" || method !== "transition") {
      return { valid: true };
    }

    const input = args as { id?: string; state?: string };
    const resource = await loadResource(input.id);

    if (resource.state === "deleted" && input.state === "active") {
      return {
        valid: false,
        issues: [
          {
            code: "invalid-lifecycle-transition",
            path: "state",
            message: "A deleted resource cannot transition directly to active.",
            suggestion: "Restore the resource before activating it."
          }
        ]
      };
    }

    return { valid: true };
  }
};
```

Call validation runs after the durable runtime decides that the connector will execute, but before `connector.executeTool()`. An invalid result marks the execution as failed, and the connector action does not run. Generated code cannot catch the local error and continue to later connector side effects because the durable execution is already terminal.

Applied calls served from the durable replay log are not revalidated. Ephemeral calls marked `replay: "reexecute"` are validated each time because they execute again. Approval-required calls validate after approval, immediately before the connector action.

Validator implementations are reconstructed with the runtime on each request. Codemode records call-validator names on a paused execution and refuses to resume if one is missing, so an approval handler cannot accidentally bypass the call policy that guarded the original run. Code-only validators do not need to be reconstructed for resume because they already decided whether the stored program could begin.

## Validation issues

Issues are optional. An invalid result without issues uses a generic validation message. Include issues when the model can use the details to correct its program:

```ts
return {
  valid: false,
  issues: [
    {
      message: "ownerId and region contain values in the wrong fields.",
      path: "body.ownerId",
      code: "swapped-fields",
      suggestion:
        "Use the account ID for ownerId and the region code for region."
    }
  ]
};
```

Validators reject code or calls; they do not transform them. Perform normalization explicitly in a connector if your API requires it. Keeping validation reject-only ensures that generated code, approval data, durable logs, and rollback arguments all describe the same call.

## Failure behavior

Configured validation hooks fail closed. If a hook throws or returns an invalid result, Codemode logs the original value or exception in the host and blocks the operation. The model receives a generic error that names the validator but does not include thrown details, which could contain private application data.

Validators should perform reads rather than side effects. Upstream APIs should still enforce transactional invariants because validation cannot prevent state from changing between a check and the eventual remote operation.

## Built-in static validators

Codemode ships two `validateCode` validators that reject programs which cannot succeed before a dynamic Worker execution is created. Both use the Oxc parser and semantic analyzer compiled to WebAssembly (`workerd-oxc`), so they run inside the Workers runtime with no external service.

```ts
import {
  createCodemodeRuntime,
  syntaxValidator,
  semanticValidator
} from "@cloudflare/codemode";

const runtime = createCodemodeRuntime({
  ctx: this.ctx,
  executor,
  connectors,
  validators: [syntaxValidator(), semanticValidator()]
});
```

### `syntaxValidator(options?)`

Rejects code that is not parseable. The executor runs generated code as plain JavaScript, so the validator parses as JavaScript by default and rejects TypeScript-only syntax that would fail at execution.

| Option      | Type           | Default    | Purpose                                                             |
| ----------- | -------------- | ---------- | ------------------------------------------------------------------- |
| `name`      | `string`       | `"syntax"` | Name attributed on diagnostics.                                     |
| `language`  | `"js" \| "ts"` | `"js"`     | Language to parse as. Use `"ts"` only if the executor strips types. |
| `maxIssues` | `number`       | `10`       | Maximum number of syntax diagnostics to report.                     |

### `semanticValidator(options?)`

Rejects code that parses but references things that do not exist:

- **Unknown connectors** — a bare identifier that is neither a configured connector, the built-in `codemode` provider, nor an ambient JavaScript/Workers global. Such code throws `X is not defined` the moment it runs.
- **Unknown methods** — a call to a method a configured connector does not expose. Enabled by default; disable with `checkMethods: false`. Connectors whose descriptors are empty are skipped because their method set is unknown.

| Option           | Type                | Default      | Purpose                                                                      |
| ---------------- | ------------------- | ------------ | ---------------------------------------------------------------------------- |
| `name`           | `string`            | `"semantic"` | Name attributed on diagnostics.                                              |
| `allowedGlobals` | `readonly string[]` | `[]`         | Extra injected identifiers to permit, such as the names of custom providers. |
| `checkMethods`   | `boolean`           | `true`       | Also reject calls to methods a connector does not expose.                    |
| `maxIssues`      | `number`            | `10`         | Maximum number of issues to report.                                          |

The semantic analyzer works on a single file and has no knowledge of the ambient environment, so it treats every free identifier as unresolved. The validator subtracts a curated set of standard JavaScript and Workers globals (exported as `AMBIENT_SANDBOX_GLOBALS`) plus the built-in `codemode` provider before deciding an identifier is an unknown connector. Applications that register custom providers must list those provider names in `allowedGlobals`.

Because these are `validateCode` validators, they run before the executor starts and a rejection creates no execution. They do not implement `validateToolCall`, so they are not recorded as resume-required.
