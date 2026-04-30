import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hashArgs } from "../argsHash.js";
import { assertContext, type ExecutionContext } from "../context.js";
import { classifyError, errorMessage, ValidationError } from "../errors.js";
import { runTool } from "../executor.js";
import { type ToolDescriptor, tools as defaultTools } from "../registry.js";

const META_CONTEXT_KEYS = ["companyId", "projectId", "issueId", "actor"] as const;

export interface CreateMcpServerOptions {
  tools?: ToolDescriptor[];
  name?: string;
  version?: string;
}

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function createMcpServer(registry: ToolDescriptor[]): McpServer;
export function createMcpServer(opts?: CreateMcpServerOptions): McpServer;
export function createMcpServer(optsOrRegistry: CreateMcpServerOptions | ToolDescriptor[] = {}): McpServer {
  const opts = Array.isArray(optsOrRegistry) ? { tools: optsOrRegistry } : optsOrRegistry;
  const toolList = opts.tools ?? defaultTools;
  const server = new McpServer({
    name: opts.name ?? "paperclip-tool-registry",
    version: opts.version ?? "0.3.1",
  });
  const descriptorsById = new Map(toolList.map((desc) => [desc.id, desc]));

  for (const desc of toolList) {
    server.registerTool(
      desc.id,
      {
        description: desc.description,
        inputSchema: desc.inputSchema,
        annotations: {
          readOnlyHint: desc.readOnly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input, extra) => executeToolDescriptor(desc, input, extra._meta),
    );
  }

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const desc = descriptorsById.get(request.params.name);
    if (!desc) {
      return formatErrorResponse(new ValidationError(`Unknown tool: ${request.params.name}`));
    }
    return executeToolDescriptor(desc, request.params.arguments ?? {}, extra._meta);
  });

  return server;
}

function executeToolDescriptor(desc: ToolDescriptor, input: unknown, meta: unknown): Promise<McpTextResponse> {
  return (async () => {
    try {
      const ctx = extractContextFromMeta(meta, desc.id, hashArgs(input));
      const parsed = parseToolInput(desc, input);
      const out = await runTool(ctx, () => desc.handler(ctx, parsed));
      return formatTextResponse(out);
    } catch (error) {
      return formatErrorResponse(error);
    }
  })();
}

function parseToolInput(desc: ToolDescriptor, input: unknown): unknown {
  const parsed = desc.inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Invalid ${desc.id} input: ${parsed.error.issues[0]?.message ?? "invalid input"}`);
  }
  return parsed.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractContextFromMeta(meta: unknown, toolId: string, argsHash: string): ExecutionContext {
  const record = isRecord(meta) ? meta : {};
  const missing = META_CONTEXT_KEYS.filter((key) => !readString(record, key));
  if (missing.length > 0) {
    throw new ValidationError(`execution context missing: ${missing.join(", ")}`);
  }

  return assertContext({
    companyId: readString(record, "companyId"),
    projectId: readString(record, "projectId"),
    issueId: readString(record, "issueId"),
    runId: readString(record, "runId"),
    actor: readString(record, "actor"),
    toolName: toolId,
    argsHash,
  });
}

function formatTextResponse(value: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2) ?? "null",
      },
    ],
  };
}

function formatErrorResponse(error: unknown): McpTextResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: classifyError(error),
            message: errorMessage(error),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}
