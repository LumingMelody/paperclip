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
 * Sub-issue assigned to a business agent — push "🎯 接到任务".
 *
 * Skipped if:
 * - assigneeAgentId is null (unassigned issue)
 * - parentId is null (top-level issue — the user-facing one, already
 *   handled by Concierge bot's polling reply path)
 * - no matching registry entry (channel not provisioned)
 */
export async function broadcastIssueAssigned(issue: BroadcastIssue): Promise<void> {
  try {
    if (!issue.assigneeAgentId) return;
    if (!issue.parentId) return; // only sub-issues
    const match = await lookupChannelByAgent(issue.assigneeAgentId);
    if (!match) return;
    const title = `🎯 ${labelForChannel(match.channelName)} 接到任务`;
    const text = [
      `**${abbreviate(issue.title ?? "(untitled)", 80)}**`,
      "",
      `issue: \`${issue.id}\``,
      "",
      "_由 Concierge 派单 · 处理中..._",
    ].join("\n");
    await pushMarkdown(match.entry, title, text);
    log.info(`pushed assigned card → agent=${issue.assigneeAgentId} issue=${issue.id}`);
  } catch (err) {
    log.warn(`broadcastIssueAssigned failed (issue=${issue.id}):`, err);
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
    if (!issue.parentId) return; // only sub-issues
    const match = await lookupChannelByAgent(issue.assigneeAgentId);
    if (!match) return;
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
