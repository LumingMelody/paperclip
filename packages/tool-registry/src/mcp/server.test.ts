import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashArgs } from "../argsHash.js";
import type { ExecutionContext } from "../context.js";
import type { ToolDescriptor } from "../registry.js";
import { tools } from "../registry.js";

const { runToolMock } = vi.hoisted(() => ({
  runToolMock: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../executor.js", () => ({
  runTool: runToolMock,
}));

import { createMcpServer } from "./server.js";

const validMeta = {
  companyId: "company_123",
  projectId: "project_456",
  issueId: "issue_789",
  runId: "run_abc",
  actor: "agent",
};

const testInputSchema = z
  .object({
    sku: z.string().min(1),
  })
  .strict();

const testDescriptor: ToolDescriptor<z.infer<typeof testInputSchema>, { sku: string }> = {
  id: "test.lookup",
  cliSubcommand: "lookup",
  source: "test",
  description: "Lookup a test SKU.",
  readOnly: true,
  inputSchema: testInputSchema,
  outputSchema: z.object({ sku: z.string() }).strict(),
  handler: async (_ctx, input) => ({ sku: input.sku }),
};

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-registry-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ContentResult = {
  content: Array<{ type: string; text?: string }>;
};

function hasContent(value: unknown): value is ContentResult {
  return typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content);
}

function readTextContent(result: unknown): string {
  if (!hasContent(result)) {
    throw new Error("Expected MCP result with content");
  }
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected first MCP content item to be text");
  }
  return first.text;
}

function parseToolError(result: unknown): {
  error?: string;
  message?: string;
} {
  return JSON.parse(readTextContent(result)) as { error?: string; message?: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  runToolMock.mockImplementation(async (_ctx: unknown, fn: () => Promise<unknown>) => fn());
});

describe("createMcpServer", () => {
  it("lists every registry tool", async () => {
    const server = createMcpServer();
    const client = await connect(server);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(tools.length);
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(tools.map((tool) => tool.id).sort());
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("dispatches a valid tool call through runTool with execution context from _meta", async () => {
    runToolMock.mockResolvedValue({ ok: true });

    const server = createMcpServer({ tools: [testDescriptor] });
    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: testDescriptor.id,
        arguments: { sku: "SKU-1" },
        _meta: validMeta,
      });

      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }],
      });
      expect(runToolMock).toHaveBeenCalledTimes(1);
      const ctx = runToolMock.mock.calls[0]?.[0] as ExecutionContext | undefined;
      expect(ctx).toEqual({
        companyId: validMeta.companyId,
        projectId: validMeta.projectId,
        issueId: validMeta.issueId,
        runId: validMeta.runId,
        actor: validMeta.actor,
        toolName: testDescriptor.id,
        argsHash: hashArgs({ sku: "SKU-1" }),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a ValidationError when _meta is missing required context keys", async () => {
    const server = createMcpServer({ tools: [testDescriptor] });
    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: testDescriptor.id,
        arguments: { sku: "SKU-1" },
        _meta: { companyId: validMeta.companyId },
      });

      expect(result.isError).toBe(true);
      const error = parseToolError(result);
      expect(error.error).toBe("ValidationError");
      expect(error.message).toContain("execution context missing");
      expect(error.message).toContain("projectId");
      expect(error.message).toContain("issueId");
      expect(error.message).toContain("actor");
      expect(runToolMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("falls back to PAPERCLIP_* env vars when _meta is omitted", async () => {
    const original = {
      company: process.env.PAPERCLIP_COMPANY_ID,
      project: process.env.PAPERCLIP_PROJECT_ID,
      issue: process.env.PAPERCLIP_ISSUE_ID,
      actor: process.env.PAPERCLIP_ACTOR,
    };
    process.env.PAPERCLIP_COMPANY_ID = validMeta.companyId;
    process.env.PAPERCLIP_PROJECT_ID = validMeta.projectId;
    process.env.PAPERCLIP_ISSUE_ID = validMeta.issueId;
    // Deliberately omit PAPERCLIP_ACTOR — it should default to "agent"
    // when company env is set, mirroring how claude_local injects context.

    const server = createMcpServer({ tools: [testDescriptor] });
    const client = await connect(server);
    try {
      runToolMock.mockReset();
      runToolMock.mockResolvedValueOnce({ envFallback: "ok" });

      const result = await client.callTool({
        name: testDescriptor.id,
        arguments: { sku: "SKU-2" },
        // No _meta passed — server must resolve context from env vars.
      });

      expect(result.isError).toBeFalsy();
      expect(runToolMock).toHaveBeenCalledTimes(1);
      const ctx = runToolMock.mock.calls[0]?.[0] as ExecutionContext;
      expect(ctx).toMatchObject({
        companyId: validMeta.companyId,
        projectId: validMeta.projectId,
        issueId: validMeta.issueId,
        actor: "agent",
        toolName: testDescriptor.id,
      });
    } finally {
      await client.close();
      await server.close();
      if (original.company === undefined) delete process.env.PAPERCLIP_COMPANY_ID;
      else process.env.PAPERCLIP_COMPANY_ID = original.company;
      if (original.project === undefined) delete process.env.PAPERCLIP_PROJECT_ID;
      else process.env.PAPERCLIP_PROJECT_ID = original.project;
      if (original.issue === undefined) delete process.env.PAPERCLIP_ISSUE_ID;
      else process.env.PAPERCLIP_ISSUE_ID = original.issue;
      if (original.actor === undefined) delete process.env.PAPERCLIP_ACTOR;
      else process.env.PAPERCLIP_ACTOR = original.actor;
    }
  });

  it("_meta takes precedence over env vars when both are set", async () => {
    const original = process.env.PAPERCLIP_COMPANY_ID;
    process.env.PAPERCLIP_COMPANY_ID = "11111111-1111-1111-1111-111111111111";
    process.env.PAPERCLIP_PROJECT_ID = "22222222-2222-2222-2222-222222222222";
    process.env.PAPERCLIP_ISSUE_ID = "ENV-1";

    const server = createMcpServer({ tools: [testDescriptor] });
    const client = await connect(server);
    try {
      runToolMock.mockReset();
      runToolMock.mockResolvedValueOnce({ override: "ok" });

      await client.callTool({
        name: testDescriptor.id,
        arguments: { sku: "SKU-3" },
        _meta: validMeta, // explicit _meta should win
      });

      const ctx = runToolMock.mock.calls[0]?.[0] as ExecutionContext;
      expect(ctx.companyId).toBe(validMeta.companyId); // not the env override
      expect(ctx.issueId).toBe(validMeta.issueId);
    } finally {
      await client.close();
      await server.close();
      if (original === undefined) delete process.env.PAPERCLIP_COMPANY_ID;
      else process.env.PAPERCLIP_COMPANY_ID = original;
      delete process.env.PAPERCLIP_PROJECT_ID;
      delete process.env.PAPERCLIP_ISSUE_ID;
    }
  });

  it("returns a ValidationError when tool input fails Zod validation", async () => {
    const server = createMcpServer({ tools: [testDescriptor] });
    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: testDescriptor.id,
        arguments: { sku: "" },
        _meta: validMeta,
      });

      expect(result.isError).toBe(true);
      const error = parseToolError(result);
      expect(error.error).toBe("ValidationError");
      expect(error.message).toContain(`Invalid ${testDescriptor.id} input`);
      expect(runToolMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a ValidationError for an unknown tool name", async () => {
    const server = createMcpServer({ tools: [testDescriptor] });
    const client = await connect(server);
    try {
      const result = await client.callTool({
        name: "test.missing",
        arguments: { sku: "SKU-1" },
        _meta: validMeta,
      });

      expect(result.isError).toBe(true);
      const error = parseToolError(result);
      expect(error.error).toBe("ValidationError");
      expect(error.message).toContain("Unknown tool: test.missing");
      expect(runToolMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.skip("smoke lists registry tools over the built pcl-tools-mcp stdio server", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const child = spawn("node", ["packages/tool-registry/dist/mcp/stdio.js"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };
    child.stdin.end(`${JSON.stringify(request)}\n`);
    const [stdout] = await once(child.stdout, "data");
    const response = String(stdout);
    for (const tool of tools) {
      expect(response).toContain(tool.id);
    }
    child.kill();
  });
});
