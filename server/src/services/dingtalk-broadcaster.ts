/**
 * Phase 6.1 — DingTalk proactive broadcaster.
 *
 * When Concierge dispatches sub-issues to business agents (Finance, Supply,
 * ProductSizing, CXOps, Marketing, Research), this service pushes
 * `🎯 <Agent> 接到任务` cards to the agent's bound DingTalk group via the
 * Open API. When those sub-issues complete (status → done), pushes
 * `✅ <Agent> 完成` cards with the answer excerpt.
 *
 * Channel registry: each bot process writes its (agent_id → credentials)
 * mapping to `~/.paperclip/dingtalk-channels.json` on startup; this service
 * reads that file on each broadcast. Stale entries (bot dead) cause silent
 * 401/network errors — logged at warn level, never crash the issue mutation.
 *
 * Wire shape mirrors active_push.py:
 *   POST https://api.dingtalk.com/v1.0/oauth2/accessToken
 *   POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
 *     header x-acs-dingtalk-access-token: <accessToken>
 *     body  { robotCode, openConversationId, msgKey: "sampleMarkdown",
 *             msgParam: JSON.stringify({ title, text }) }
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { subscribeCompanyLiveEvents } from "./live-events.js";

const REGISTRY_PATH = join(homedir(), ".paperclip", "dingtalk-channels.json");
const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const PUSH_URL = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

const log = (() => {
  const prefix = "[dingtalk-broadcaster]";
  return {
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    debug: (..._args: unknown[]) => {},
  };
})();

interface ChannelEntry {
  agent_id: string;
  app_key: string;
  app_secret: string;
  robot_code?: string;
  conv_id?: string;
  updated_at?: string;
}

type Registry = Record<string, ChannelEntry>;

interface TokenCacheValue {
  value: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheValue>(); // keyed by app_key

async function loadRegistry(): Promise<Registry> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf-8");
    return JSON.parse(raw) as Registry;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    log.warn(`failed to read ${REGISTRY_PATH}:`, err);
    return {};
  }
}

async function lookupChannelByAgent(
  agentId: string,
): Promise<{ channelName: string; entry: ChannelEntry } | null> {
  if (!agentId) return null;
  const registry = await loadRegistry();
  for (const [channelName, entry] of Object.entries(registry)) {
    if (entry.agent_id === agentId) return { channelName, entry };
  }
  return null;
}

function labelForChannel(channelName: string): string {
  // concierge → Concierge, product_sizing → ProductSizing, cx_ops → CXOps, ...
  return channelName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

async function getAccessToken(entry: ChannelEntry): Promise<string> {
  const cached = tokenCache.get(entry.app_key);
  if (cached && cached.expiresAt > Date.now() + TOKEN_SAFETY_MARGIN_MS) {
    return cached.value;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: entry.app_key, appSecret: entry.app_secret }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { accessToken?: string; expireIn?: number };
  if (!body.accessToken || typeof body.expireIn !== "number") {
    throw new Error(`token refresh response missing fields: ${JSON.stringify(body)}`);
  }
  tokenCache.set(entry.app_key, {
    value: body.accessToken,
    expiresAt: Date.now() + body.expireIn * 1000,
  });
  return body.accessToken;
}

async function pushMarkdown(entry: ChannelEntry, title: string, text: string): Promise<void> {
  if (!entry.robot_code || !entry.conv_id) {
    log.debug(
      `skip push for agent=${entry.agent_id} — registry missing robot_code or conv_id (bot probably hasn't received first @-mention yet)`,
    );
    return;
  }
  const token = await getAccessToken(entry);
  const res = await fetch(PUSH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify({
      robotCode: entry.robot_code,
      openConversationId: entry.conv_id,
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify({ title, text }),
    }),
  });
  if (res.status === 401) {
    // Stale token — drop cache, retry once.
    tokenCache.delete(entry.app_key);
    const fresh = await getAccessToken(entry);
    const retry = await fetch(PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": fresh,
      },
      body: JSON.stringify({
        robotCode: entry.robot_code,
        openConversationId: entry.conv_id,
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({ title, text }),
      }),
    });
    if (!retry.ok) {
      const txt = await retry.text();
      throw new Error(`push retry-after-401 failed: HTTP ${retry.status} ${txt.slice(0, 200)}`);
    }
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`push failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

function abbreviate(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface BroadcastIssue {
  id: string;
  title: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  status?: string | null;
}

/**
 * Issue assigned to a business agent — push "🎯 接到任务".
 *
 * Fires for both:
 *  - sub-issues (parentId set) — Concierge dispatched to a business agent
 *  - top-level issues assigned to a non-Concierge agent — direct-route @ in
 *    a per-channel bot's group (Phase 6 multi-channel)
 *
 * Skipped if:
 * - assigneeAgentId is null (unassigned issue)
 * - no matching registry entry (channel not provisioned)
 * - channel name is "concierge" (Concierge owns its own group reply path —
 *   broadcasting would duplicate the bot's own "🤔 思考中" + final answer)
 */
export async function broadcastIssueAssigned(issue: BroadcastIssue): Promise<void> {
  try {
    if (!issue.assigneeAgentId) return;
    const match = await lookupChannelByAgent(issue.assigneeAgentId);
    if (!match) return;
    if (match.channelName === "concierge") return; // Concierge bot handles its group
    const title = `🎯 ${labelForChannel(match.channelName)} 接到任务`;
    const dispatchNote = issue.parentId
      ? "_由 Concierge 派单 · 处理中..._"
      : "_直接路由 · 处理中..._";
    const text = [
      `**${abbreviate(issue.title ?? "(untitled)", 80)}**`,
      "",
      `issue: \`${issue.id}\``,
      "",
      dispatchNote,
    ].join("\n");
    await pushMarkdown(match.entry, title, text);
    log.info(`pushed assigned card → agent=${issue.assigneeAgentId} issue=${issue.id}`);
  } catch (err) {
    log.warn(`broadcastIssueAssigned failed (issue=${issue.id}):`, err);
  }
}

/**
 * Agent wrote a comment to its own issue → push "📝 <Agent>: <excerpt>".
 *
 * Throttled per-issue (one push every PROGRESS_THROTTLE_MS) to avoid spamming
 * groups when an agent emits many comments in quick succession during a run.
 * Skipped if:
 * - comment author is not the issue's assigneeAgentId (e.g. user follow-up)
 * - issue's assignee has no channel (channel not provisioned)
 * - channel name is "concierge" (Concierge bot handles its own group reply)
 */
const PROGRESS_THROTTLE_MS = 25_000;
const lastProgressPushAt = new Map<string, number>();

export async function broadcastIssueProgress(
  issue: BroadcastIssue,
  comment: { id: string; body: string | null; authorAgentId: string | null },
): Promise<void> {
  try {
    if (!issue.assigneeAgentId) return;
    if (!comment.body || comment.body.trim().length === 0) return;
    if (comment.authorAgentId !== issue.assigneeAgentId) return; // only agent's own progress notes

    const now = Date.now();
    const lastAt = lastProgressPushAt.get(issue.id) ?? 0;
    if (now - lastAt < PROGRESS_THROTTLE_MS) return;

    const match = await lookupChannelByAgent(issue.assigneeAgentId);
    if (!match) return;
    if (match.channelName === "concierge") return; // Concierge bot owns its group reply path

    lastProgressPushAt.set(issue.id, now);
    const title = `📝 ${labelForChannel(match.channelName)} 进度`;
    const text = [
      `**${abbreviate(issue.title ?? "(untitled)", 60)}**`,
      "",
      abbreviate(comment.body, 600),
      "",
      `_issue: \`${issue.id}\`_`,
    ].join("\n");
    await pushMarkdown(match.entry, title, text);
    log.info(`pushed progress card → agent=${issue.assigneeAgentId} issue=${issue.id}`);
  } catch (err) {
    log.warn(`broadcastIssueProgress failed (issue=${issue.id}):`, err);
  }
}

/**
 * Sub-issue done — push "✅ 完成" with the answer excerpt.
 */
export async function broadcastIssueDone(
  issue: BroadcastIssue,
  latestAnswerBody: string | null | undefined,
): Promise<void> {
  try {
    if (!issue.assigneeAgentId) return;
    const match = await lookupChannelByAgent(issue.assigneeAgentId);
    if (!match) return;
    if (match.channelName === "concierge") return; // Concierge bot pushes its own done reply
    // For top-level direct-route issues, the per-channel bot will ALSO push the
    // final answer via its poll path — we skip the broadcaster's done card to
    // avoid posting the same content twice. For sub-issues (parentId set),
    // the dispatching bot polls the PARENT, not this sub-issue, so no
    // duplication risk.
    if (!issue.parentId) return;
    const title = `✅ ${labelForChannel(match.channelName)} 完成`;
    const text = [
      `**${abbreviate(issue.title ?? "(untitled)", 80)}**`,
      "",
      latestAnswerBody ? abbreviate(latestAnswerBody, 800) : "_(no answer body)_",
      "",
      `_issue: \`${issue.id}\` — 由 Concierge 聚合最终答复_`,
    ].join("\n");
    await pushMarkdown(match.entry, title, text);
    log.info(`pushed done card → agent=${issue.assigneeAgentId} issue=${issue.id}`);
  } catch (err) {
    log.warn(`broadcastIssueDone failed (issue=${issue.id}):`, err);
  }
}

// ─── Narration stream subscription ──────────────────────────────────────
//
// Subscribes to `heartbeat.run.log` live events (one per Claude SDK stdout
// chunk) and extracts user-visible narration (assistant text + thinking
// blocks). Throttled per-agent so a chatty agent doesn't spam its group.
// Skipped silently if channel is concierge or registry entry missing.

const NARRATION_THROTTLE_MS = 35_000;
const TOOL_USE_THROTTLE_MS = 15_000;
const lastNarrationAt = new Map<string, number>(); // agentId → last push ts
const lastNarrationText = new Map<string, string>(); // agentId → last pushed text (dedup)
const lastToolUseAt = new Map<string, number>(); // agentId → last tool push ts
const lastToolUseNames = new Map<string, string>(); // agentId → last pushed tool names (dedup)
const subscribedCompanies = new Set<string>();

interface ToolUse {
  name: string;
  args: string; // pretty-formatted arg summary (truncated)
}

function summarizeToolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const pieces: string[] = [];
  for (const [k, v] of entries) {
    let display: string;
    if (typeof v === "string") {
      display = v.length > 30 ? `${v.slice(0, 28)}…` : v;
      display = `"${display}"`;
    } else if (typeof v === "number" || typeof v === "boolean") {
      display = String(v);
    } else if (Array.isArray(v)) {
      display = `[${v.length}]`;
    } else if (v === null) {
      display = "null";
    } else {
      display = "{…}";
    }
    pieces.push(`${k}=${display}`);
    if (pieces.join(", ").length > 90) break;
  }
  return pieces.join(", ");
}

function extractToolUsesFromChunk(rawChunk: string): ToolUse[] {
  if (!rawChunk || rawChunk.length === 0) return [];
  const lines = rawChunk.split("\n");
  const tools: ToolUse[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ev = parsed as { type?: string; message?: { content?: unknown } };
    if (ev.type !== "assistant") continue;
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type === "tool_use" && typeof b.name === "string") {
        // Trim MCP prefix for readability: mcp__paperclip-data__dws_returnsBySku → dws_returnsBySku
        const shortName = b.name.replace(/^mcp__[^_]+__/, "");
        tools.push({ name: shortName, args: summarizeToolArgs(b.input) });
      }
    }
  }
  return tools;
}

async function handleToolUseFromChunk(
  agentId: string,
  rawChunk: string,
): Promise<void> {
  const now = Date.now();
  const lastAt = lastToolUseAt.get(agentId) ?? 0;
  if (now - lastAt < TOOL_USE_THROTTLE_MS) return;

  const tools = extractToolUsesFromChunk(rawChunk);
  if (tools.length === 0) return;

  // Dedup against the exact set of tool names just pushed.
  const namesKey = tools.map((t) => t.name).sort().join("|");
  if (lastToolUseNames.get(agentId) === namesKey) return;

  try {
    const match = await lookupChannelByAgent(agentId);
    if (!match) return;
    if (match.channelName === "concierge") return;

    lastToolUseAt.set(agentId, now);
    lastToolUseNames.set(agentId, namesKey);

    const title = `🔧 ${labelForChannel(match.channelName)} 调用工具`;
    const lines = tools.slice(0, 6).map((t) => {
      const argPart = t.args ? ` \`${t.args}\`` : "";
      return `- \`${t.name}\`${argPart}`;
    });
    if (tools.length > 6) lines.push(`- _… 还有 ${tools.length - 6} 个_`);
    await pushMarkdown(match.entry, title, lines.join("\n"));
    log.info(`pushed tool_use card → agent=${agentId} tools=${tools.length}`);
  } catch (err) {
    log.warn(`handleToolUseFromChunk failed (agent=${agentId}):`, err);
  }
}

function extractNarrationFromChunk(rawChunk: string): string | null {
  // Each `heartbeat.run.log` payload is a concatenation of one or more NDJSON
  // lines from a Claude SDK stream. We parse line-by-line and look for the
  // most recent assistant text. Defensive: ignore malformed JSON, tool_use,
  // tool_result, system events.
  if (!rawChunk || rawChunk.length === 0) return null;
  const lines = rawChunk.split("\n");
  let latest: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as { type?: string; message?: { content?: unknown } };
    if (ev.type !== "assistant") continue;
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const pieces: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; thinking?: string };
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        pieces.push(b.text.trim());
      }
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        // Thinking blocks are usually long internal monologue — take last 2 sentences
        // to keep the card readable.
        const t = b.thinking.trim();
        const sentences = t.split(/(?<=[。!?\.])\s*/).filter((s) => s.length > 0);
        pieces.push(sentences.slice(-2).join(" "));
      }
    }
    if (pieces.length > 0) {
      latest = pieces.join("\n\n");
    }
  }
  return latest;
}

async function handleRunLogEvent(payload: {
  agentId?: string;
  stream?: string;
  chunk?: string;
}): Promise<void> {
  if (!payload?.agentId || payload.stream !== "stdout" || !payload.chunk) return;
  const agentId = payload.agentId;

  // Tool-use detection runs every event (its own throttle); it's cheap and
  // doesn't depend on the narration throttle.
  void handleToolUseFromChunk(agentId, payload.chunk);

  const now = Date.now();
  const lastAt = lastNarrationAt.get(agentId) ?? 0;
  if (now - lastAt < NARRATION_THROTTLE_MS) return; // cheap pre-filter before parse

  const text = extractNarrationFromChunk(payload.chunk);
  if (!text || text.length < 20) return; // skip noise

  const lastText = lastNarrationText.get(agentId);
  if (lastText === text) return; // dedup identical

  try {
    const match = await lookupChannelByAgent(agentId);
    if (!match) return;
    if (match.channelName === "concierge") return;

    lastNarrationAt.set(agentId, now);
    lastNarrationText.set(agentId, text);

    const title = `💭 ${labelForChannel(match.channelName)} 正在思考`;
    const body = abbreviate(text, 700);
    await pushMarkdown(match.entry, title, body);
    log.info(`pushed narration card → agent=${agentId} bytes=${text.length}`);
  } catch (err) {
    log.warn(`handleRunLogEvent failed (agent=${agentId}):`, err);
  }
}

/**
 * Subscribe to a company's live events to relay Claude SDK narration into
 * the bound DingTalk group as "💭 思考中" cards. Idempotent per company.
 * Call once on server startup per company.
 */
export function initBroadcasterSubscriptions(companyId: string): void {
  if (subscribedCompanies.has(companyId)) return;
  subscribedCompanies.add(companyId);
  subscribeCompanyLiveEvents(companyId, (event) => {
    if (event.type !== "heartbeat.run.log") return;
    void handleRunLogEvent(event.payload as { agentId?: string; stream?: string; chunk?: string });
  });
  log.info(`subscribed to heartbeat.run.log stream for company=${companyId}`);
}
