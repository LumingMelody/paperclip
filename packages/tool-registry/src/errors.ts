export const errorClassNames = [
  "SecretsNotConfigured",
  "InstanceLookupFailed",
  "ValidationError",
  "UpstreamError",
  "NotFound",
  "InternalError",
] as const;

export type ToolErrorClass = (typeof errorClassNames)[number];

const errorClassNameSet = new Set<string>(errorClassNames);

export abstract class ToolRegistryError extends Error {
  abstract readonly class: ToolErrorClass;
}

export class SecretsNotConfigured extends ToolRegistryError {
  readonly class = "SecretsNotConfigured" as const;

  constructor(message = "Tool secrets are not configured") {
    super(message);
    this.name = this.class;
  }
}

export class InstanceLookupFailed extends ToolRegistryError {
  readonly class = "InstanceLookupFailed" as const;

  constructor(message = "Could not resolve the Paperclip instance for this company") {
    super(message);
    this.name = this.class;
  }
}

export class ValidationError extends ToolRegistryError {
  readonly class = "ValidationError" as const;

  constructor(message = "Invalid tool input") {
    super(message);
    this.name = this.class;
  }
}

export class UpstreamError extends ToolRegistryError {
  readonly class = "UpstreamError" as const;

  constructor(message = "Upstream tool call failed") {
    super(message);
    this.name = this.class;
  }
}

export class NotFound extends ToolRegistryError {
  readonly class = "NotFound" as const;

  constructor(message = "Requested resource was not found") {
    super(message);
    this.name = this.class;
  }
}

export class InternalError extends ToolRegistryError {
  readonly class = "InternalError" as const;

  constructor(message = "Internal tool-registry error") {
    super(message);
    this.name = this.class;
  }
}

export function isToolErrorClass(value: unknown): value is ToolErrorClass {
  return typeof value === "string" && errorClassNameSet.has(value);
}

export function classifyError(error: unknown): ToolErrorClass {
  if (error instanceof ToolRegistryError) return error.class;
  if (typeof error === "object" && error !== null && "class" in error) {
    const maybeClass = (error as { class: unknown }).class;
    if (isToolErrorClass(maybeClass)) return maybeClass;
  }
  return "InternalError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
