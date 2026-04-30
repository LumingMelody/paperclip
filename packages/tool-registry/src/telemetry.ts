import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { z } from "zod";
import { InstanceLookupFailed, type ToolErrorClass } from "./errors.js";

export type ToolCallStatus = "success" | "error";

export interface ToolCallEntry {
  ts: string;
  company: string;
  project: string;
  issue: string;
  runId?: string;
  tool: string;
  argsHash: string;
  status: ToolCallStatus;
  durationMs: number;
  costUnits?: number;
  errorClass?: ToolErrorClass;
}

const explicitCompanyObjectSchema = z.object({
  id: z.string().optional(),
  companyId: z.string().optional(),
});

const instanceConfigSchema = z
  .object({
    companyId: z.string().optional(),
    company: explicitCompanyObjectSchema.optional(),
    companyIds: z.array(z.string()).optional(),
    companies: z.union([z.array(z.union([z.string(), explicitCompanyObjectSchema])), z.record(z.unknown())]).optional(),
  })
  .passthrough();

export function paperclipHomePath(): string {
  return path.join(os.homedir(), ".paperclip");
}

function arrayCompaniesMatch(companies: Array<string | z.infer<typeof explicitCompanyObjectSchema>>, companyId: string): boolean {
  return companies.some((company) => {
    if (typeof company === "string") return company === companyId;
    return company.id === companyId || company.companyId === companyId;
  });
}

async function instanceHasCompanyProject(instanceRoot: string, companyId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(instanceRoot, "projects", companyId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function configMatchesCompany(configPath: string, companyId: string): Promise<boolean> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsedJson = JSON.parse(raw) as unknown;
  const parsed = instanceConfigSchema.safeParse(parsedJson);
  if (!parsed.success) return false;
  const config = parsed.data;
  if (config.companyId === companyId) return true;
  if (config.company?.id === companyId || config.company?.companyId === companyId) return true;
  if (config.companyIds?.includes(companyId)) return true;
  if (Array.isArray(config.companies)) return arrayCompaniesMatch(config.companies, companyId);
  if (config.companies && typeof config.companies === "object" && companyId in config.companies) return true;
  return instanceHasCompanyProject(path.dirname(configPath), companyId);
}

export async function resolveProjectWorkspace(companyId: string, projectId: string): Promise<string> {
  const instancesRoot = path.join(paperclipHomePath(), "instances");
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await fs.readdir(instancesRoot, { encoding: "utf8", withFileTypes: true });
  } catch {
    throw new InstanceLookupFailed(`No Paperclip instances directory found at ${instancesRoot}`);
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const instanceRoot = path.join(instancesRoot, entry.name);
    const configPath = path.join(instanceRoot, "config.json");
    try {
      if (await configMatchesCompany(configPath, companyId)) matches.push(entry.name);
    } catch {
      continue;
    }
  }

  if (matches.length !== 1) {
    throw new InstanceLookupFailed(
      `Expected exactly one Paperclip instance for company ${companyId}; found ${matches.length}`,
    );
  }

  return path.join(instancesRoot, matches[0], "projects", companyId, projectId);
}

export async function recordToolCall(entry: ToolCallEntry): Promise<void> {
  const projectWorkspace = await resolveProjectWorkspace(entry.company, entry.project);
  await fs.mkdir(projectWorkspace, { recursive: true });
  const logPath = path.join(projectWorkspace, "tool_calls.jsonl");
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}
