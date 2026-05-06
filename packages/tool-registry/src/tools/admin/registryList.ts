import { z } from "zod";
import type { ExecutionContext } from "../../context.js";
import type { ToolDescriptor } from "../../registry.js";

const inputSchema = z
  .object({
    source: z.string().min(1).max(64).optional(),
    grep: z.string().min(1).max(200).optional(),
  })
  .strict();

const toolEntrySchema = z.object({
  id: z.string(),
  source: z.string(),
  cliSubcommand: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  requiredSecrets: z.array(z.string()),
  inputFields: z.array(z.string()),
});

const outputSchema = z.object({
  tools: z.array(toolEntrySchema),
  total: z.number().int().nonnegative(),
});

export type RegistryListInput = z.infer<typeof inputSchema>;
export type RegistryListOutput = z.infer<typeof outputSchema>;

/**
 * Walk through ZodEffects (.refine/.transform) wrappers to find the underlying
 * object schema's keys. Mirrors the helper in cli.ts but local to keep tool
 * dependency-free.
 */
function describeInputFields(schema: unknown): string[] {
  let node: unknown = schema;
  for (let i = 0; i < 5; i += 1) {
    const candidate = node as {
      shape?: Record<string, unknown>;
      _def?: {
        shape?: Record<string, unknown> | (() => Record<string, unknown>);
        schema?: unknown;
        innerType?: unknown;
      };
    };
    const shape =
      candidate.shape ??
      (typeof candidate._def?.shape === "function" ? candidate._def.shape() : candidate._def?.shape);
    if (shape && typeof shape === "object") return Object.keys(shape);
    if (candidate._def?.schema) {
      node = candidate._def.schema;
      continue;
    }
    if (candidate._def?.innerType) {
      node = candidate._def.innerType;
      continue;
    }
    break;
  }
  return [];
}

function describe(tool: ToolDescriptor): z.infer<typeof toolEntrySchema> {
  return {
    id: tool.id,
    source: tool.source,
    cliSubcommand: tool.cliSubcommand,
    description: tool.description,
    readOnly: tool.readOnly,
    requiredSecrets: tool.requiredSecrets ?? [],
    inputFields: describeInputFields(tool.inputSchema),
  };
}

export interface RegistryListOptions {
  registry?: ToolDescriptor[];
}

export function makeRegistryListDescriptor(
  opts: RegistryListOptions = {},
): ToolDescriptor<RegistryListInput, RegistryListOutput> {
  const explicitRegistry = opts.registry;
  return {
    id: "registry.list",
    cliSubcommand: "list",
    source: "registry",
    description:
      "List all tools registered in the tool-registry. Optional filter by source name or " +
      "substring grep over id/description. Useful for agent-side tool discovery.",
    readOnly: true,
    inputSchema,
    outputSchema,
    handler: async (_ctx: ExecutionContext, input: RegistryListInput) => {
      // Lazy-load to avoid circular import: registry.ts imports this descriptor at module init.
      const registry =
        explicitRegistry ?? (await import("../../registry.js")).tools;
      const grepLc = input.grep?.toLowerCase();
      const filtered = registry.filter((tool) => {
        if (input.source && tool.source !== input.source) return false;
        if (grepLc) {
          const haystack = `${tool.id}\n${tool.description}`.toLowerCase();
          if (!haystack.includes(grepLc)) return false;
        }
        return true;
      });
      const entries = filtered.map(describe);
      // Stable sort by id to keep output deterministic across registrations.
      entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { tools: entries, total: entries.length };
    },
  };
}

export const registryListDescriptor = makeRegistryListDescriptor();
