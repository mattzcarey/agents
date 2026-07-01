import type { CodeOutput } from "./shared";
import type { Executor, ResolvedProvider, ConnectorBinding } from "./executor";
import { normalizeCode } from "./normalize";

export async function runCode({
  code,
  executor,
  providers,
  connectors
}: {
  code: string;
  executor: Executor;
  providers: ResolvedProvider[];
  connectors?: ConnectorBinding[];
}): Promise<CodeOutput> {
  const executeResult = await executor.execute(
    normalizeCode(code),
    providers,
    connectors?.length ? { connectors } : undefined
  );

  if (executeResult.error) {
    const logCtx = executeResult.logs?.length
      ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
      : "";
    throw new Error(`Code execution failed: ${executeResult.error}${logCtx}`);
  }

  return {
    result: executeResult.result,
    ...(executeResult.logs?.length ? { logs: executeResult.logs } : {}),
    ...(executeResult.toolCalls?.length
      ? { toolCalls: executeResult.toolCalls }
      : {})
  };
}
