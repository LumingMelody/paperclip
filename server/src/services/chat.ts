/**
 * chat service — chat-as-issue conversation container.
 *
 * Bot 收到群消息 → POST /api/chat → chatService.handleIncoming.
 * 用 senderKey/conversationKey 维度查最近未完成 issue：
 *   - 有 → 在该 issue 加 user comment，触发 wakeup
 *   - 没 → 新建 issue (assignee=Concierge agent)，加 user comment，触发 wakeup
 *
 * Concierge agent 由 queueIssueAssignmentWakeup 触发，会跑业务逻辑、加 agent
 * comment、把 issue.status 设为 done。bot 端短轮询 GET /issues/:id 拉答案。
 */
import { and, eq, gt, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { broadcastIssueAssigned } from "./dingtalk-broadcaster.js";

export interface ChatServiceDeps {
  db: Db;
  /** Concierge agent UUID — read from process.env.PAPERCLIP_CONCIERGE_AGENT_ID at app boot. */
  conciergeAgentId: string;
  /** Heartbeat service instance forwarded to queueIssueAssignmentWakeup. */
  heartbeat: unknown;
  /** Injectable wakeup function for tests; defaults to the real queueIssueAssignmentWakeup. */
  wakeup?: typeof queueIssueAssignmentWakeup;
}

export interface ChatHandleInput {
  companyId: string;
  projectId: string;
  /** DingTalk sender_staff_id; used as conversationKey default. */
  senderKey: string;
  /** Explicit override; default = senderKey. */
  conversationKey?: string;
  /** Target agent UUID; default = deps.conciergeAgentId. Phase 6 multi-channel routing. */
  targetAgentId?: string;
  /** User message text (raw). */
  text: string;
}

export interface ChatHandleResult {
  issueId: string;
  created: boolean;
}

const NON_TERMINAL_STATUS_BLOCK = ["done", "cancelled"] as const;
const CONVERSATION_LOOKBACK_HOURS = 24;

export function chatService(deps: ChatServiceDeps) {
  return {
    async handleIncoming(input: ChatHandleInput): Promise<ChatHandleResult> {
      const convKey = input.conversationKey ?? input.senderKey;
      const lookbackSince = new Date(Date.now() - CONVERSATION_LOOKBACK_HOURS * 3600 * 1000);

      // 1) 找该 convKey 最近 24h 内仍未完结的 issue（作 "open conversation"）
      const recent = await deps.db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.dingtalkConversationKey, convKey),
            notInArray(issues.status, NON_TERMINAL_STATUS_BLOCK as unknown as string[]),
            gt(issues.createdAt, lookbackSince),
          ),
        )
        .limit(1);

      let issueId: string;
      let created: boolean;
      // effectiveAgentId: the agent to wake up after attaching the comment.
      // For new issues: targetAgentId if provided, else Concierge (default routing).
      // For existing issues: the existing assignee (preserves ongoing conversation ownership).
      let effectiveAgentId: string;

      if (recent.length > 0) {
        const existing = recent[0] as { id: string; assigneeAgentId?: string | null };
        issueId = existing.id;
        created = false;
        effectiveAgentId = existing.assigneeAgentId ?? deps.conciergeAgentId;
      } else {
        effectiveAgentId = input.targetAgentId ?? deps.conciergeAgentId;
        const inserted = await deps.db
          .insert(issues)
          .values({
            companyId: input.companyId,
            projectId: input.projectId,
            title: input.text.slice(0, 80),
            description: input.text,
            assigneeAgentId: effectiveAgentId,
            status: "todo",
            dingtalkConversationKey: convKey,
          } as typeof issues.$inferInsert)
          .returning({ id: issues.id });
        issueId = (inserted[0] as { id: string }).id;
        created = true;
      }

      // 2) 把 user 消息作为 comment 加到 issue
      await deps.db.insert(issueComments).values({
        companyId: input.companyId,
        issueId,
        authorUserId: input.senderKey,
        body: input.text,
      } as typeof issueComments.$inferInsert);

      // 3) 触发 assignee 唤醒（无 targetAgentId 时默认 Concierge）
      const wakeupFn = deps.wakeup ?? queueIssueAssignmentWakeup;
      await wakeupFn({
        heartbeat: deps.heartbeat as never,
        issue: {
          id: issueId,
          assigneeAgentId: effectiveAgentId,
          status: "todo",
        },
        reason: created ? "new chat session" : "user follow-up",
        mutation: "chat.handleIncoming",
        contextSource: "chat",
      });

      // 4) Phase 6.1 — if this is a NEW chat issue routed to a non-Concierge
      //    business agent (Finance / Supply / ...), broadcast a "🎯 接到任务"
      //    card to that agent's bound DingTalk group. broadcaster skips
      //    Concierge channel + handles all error cases silently.
      if (created) {
        const titleSlice = input.text.slice(0, 80);
        void broadcastIssueAssigned({
          id: issueId,
          title: titleSlice,
          parentId: null,
          assigneeAgentId: effectiveAgentId,
          status: "todo",
        });
      }

      return { issueId, created };
    },
  };
}
