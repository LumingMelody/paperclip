import { assertContext, type ExecutionContext } from "./context.js";
import { classifyError } from "./errors.js";
import { recordToolCall } from "./telemetry.js";

export async function runTool<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> {
  const validContext = assertContext(ctx);
  const startedAt = Date.now();
  const ts = new Date(startedAt).toISOString();

  try {
    const result = await fn();
    await recordToolCall({
      ts,
      company: validContext.companyId,
      project: validContext.projectId,
      issue: validContext.issueId,
      runId: validContext.runId,
      tool: validContext.toolName,
      argsHash: validContext.argsHash,
      status: "success",
      durationMs: Date.now() - startedAt,
      costUnits: 0,
    });
    return result;
  } catch (error) {
    try {
      await recordToolCall({
        ts,
        company: validContext.companyId,
        project: validContext.projectId,
        issue: validContext.issueId,
        runId: validContext.runId,
        tool: validContext.toolName,
        argsHash: validContext.argsHash,
        status: "error",
        durationMs: Date.now() - startedAt,
        costUnits: 0,
        errorClass: classifyError(error),
      });
    } catch {
      // Preserve the tool error; telemetry failures should not mask the original cause.
    }
    throw error;
  }
}
