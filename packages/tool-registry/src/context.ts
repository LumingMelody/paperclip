import { z } from "zod";
import { ValidationError } from "./errors.js";

export const executionActorSchema = z.enum(["agent", "user", "system"]);

export type ExecutionActor = z.infer<typeof executionActorSchema>;

const executionContextSchema = z
  .object({
    companyId: z.string().min(1),
    projectId: z.string().min(1),
    issueId: z.string().min(1),
    runId: z.string().min(1).optional(),
    actor: executionActorSchema,
    toolName: z.string().min(1),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ExecutionContext = z.infer<typeof executionContextSchema>;

export function assertContext(value: unknown): ExecutionContext {
  const parsed = executionContextSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "context"}: ${issue.message}`)
      .join("; ");
    throw new ValidationError(`Invalid execution context: ${message}`);
  }
  return parsed.data;
}
