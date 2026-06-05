import { randomUUID } from "node:crypto";
import net from "node:net";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CONCIERGE_ANSWER_TIMEOUT_FALLBACK_MARKER,
  recoveryService,
} from "../services/recovery/service.ts";

async function getLocalListenSupport() {
  return new Promise<{ supported: boolean; reason?: string }>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", (error) => {
      resolve({ supported: false, reason: error instanceof Error ? error.message : String(error) });
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve({ supported: true }));
    });
  });
}

const localListenSupport = await getLocalListenSupport();
const embeddedPostgresSupport = localListenSupport.supported
  ? await getEmbeddedPostgresTestSupport()
  : localListenSupport;
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres concierge answer-timeout watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("concierge answer-timeout watchdog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-concierge-answer-timeout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const conciergeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Concierge Timeout Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: conciergeAgentId,
        companyId,
        name: "Concierge",
        role: "concierge",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, conciergeAgentId, otherAgentId, issuePrefix };
  }

  async function seedIssue(input: {
    companyId: string;
    issuePrefix: string;
    assigneeAgentId: string | null;
    status?: string;
    dingtalkConversationKey?: string | null;
    parentId?: string | null;
    inboundCommentAt?: Date | null;
    inboundBody?: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "DingTalk chat question",
      description: "chat request",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
      parentId: input.parentId ?? null,
      dingtalkConversationKey: input.dingtalkConversationKey === undefined
        ? `ding-${issueId}`
        : input.dingtalkConversationKey,
      issueNumber: 1,
      identifier: `${input.issuePrefix}-${issueId.slice(0, 6)}`,
      createdAt: input.inboundCommentAt ?? new Date("2026-04-22T19:00:00.000Z"),
      updatedAt: input.inboundCommentAt ?? new Date("2026-04-22T19:00:00.000Z"),
    });

    if (input.inboundCommentAt) {
      await db.insert(issueComments).values({
        companyId: input.companyId,
        issueId,
        authorUserId: "ding-user-001",
        createdByRunId: null,
        body: input.inboundBody ?? "帮我分析这个问题",
        createdAt: input.inboundCommentAt,
        updatedAt: input.inboundCommentAt,
      });
    }

    return issueId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    at: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt: input.at,
      finishedAt: ["succeeded", "failed", "cancelled", "timed_out"].includes(input.status) ? input.at : null,
      processStartedAt: input.status === "running" ? input.at : null,
      lastOutputAt: input.status === "running" ? input.at : null,
      lastOutputSeq: input.status === "running" ? 25 : 0,
      lastOutputStream: input.status === "running" ? "stdout" : null,
      contextSnapshot: { issueId: input.issueId },
      stdoutExcerpt: "raw run output should not be copied into fallback comment",
      logBytes: 0,
      createdAt: input.at,
      updatedAt: input.at,
    });
    return runId;
  }

  function svc() {
    return recoveryService(db, { enqueueWakeup: vi.fn() });
  }

  async function fallbackComments(issueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          like(issueComments.body, `${CONCIERGE_ANSWER_TIMEOUT_FALLBACK_MARKER}%`),
        ),
      );
  }

  it("posts a fallback and marks done when a running Concierge run keeps outputting but the issue answer is overdue", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedCompany();
    const issueId = await seedIssue({
      ...seeded,
      assigneeAgentId: seeded.conciergeAgentId,
      status: "in_progress",
      inboundCommentAt: new Date(now.getTime() - 601_000),
    });
    const runId = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.conciergeAgentId,
      issueId,
      status: "running",
      at: new Date(now.getTime() - 10_000),
    });

    const result = await svc().reconcileConciergeAnswerTimeout({
      now,
      conciergeAgentId: seeded.conciergeAgentId,
      timeoutMs: 600_000,
    });

    expect(result).toMatchObject({
      candidates: 1,
      timedOut: 1,
      fallbackPosted: 1,
      skippedIdempotent: 0,
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt?.toISOString()).toBe(now.toISOString());

    const comments = await fallbackComments(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorUserId).toBe("system");
    expect(comments[0]?.body).toContain("⏱处理超过系统时限");
    expect(comments[0]?.body).toContain("已返回兜底");
    expect(comments[0]?.body).toContain("拆成更小");
    expect(comments[0]?.body).not.toContain("raw run output");

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "concierge.answer_timeout_fallback_posted")));
    expect(activity?.runId).toBe(runId);
    expect(activity?.details).toMatchObject({
      source: "recovery.reconcile_concierge_answer_timeout",
      activeRunId: runId,
      latestRunId: runId,
      latestRunStatus: "running",
      timeoutMs: 600_000,
    });
  });

  it("posts a fallback for blocked Concierge issues even when the latest associated run is terminal", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedCompany();
    const issueId = await seedIssue({
      ...seeded,
      assigneeAgentId: seeded.conciergeAgentId,
      status: "blocked",
      inboundCommentAt: new Date(now.getTime() - 700_000),
    });
    const runId = await seedRun({
      companyId: seeded.companyId,
      agentId: seeded.conciergeAgentId,
      issueId,
      status: "succeeded",
      at: new Date(now.getTime() - 300_000),
    });

    const result = await svc().reconcileConciergeAnswerTimeout({
      now,
      conciergeAgentId: seeded.conciergeAgentId,
      timeoutMs: 600_000,
    });

    expect(result.fallbackPosted).toBe(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("done");
    const [activity] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "concierge.answer_timeout_fallback_posted")));
    expect(activity?.runId).toBeNull();
    expect(activity?.details).toMatchObject({
      latestRunId: runId,
      latestRunStatus: "succeeded",
      activeRunId: null,
    });
  });

  it("does not trigger for non-candidates or not-yet-overdue Concierge issues", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedCompany();
    const parentId = await seedIssue({
      ...seeded,
      assigneeAgentId: seeded.conciergeAgentId,
      status: "in_progress",
      dingtalkConversationKey: null,
      inboundCommentAt: null,
    });
    const issueIds = [
      parentId,
      await seedIssue({
        ...seeded,
        assigneeAgentId: seeded.otherAgentId,
        status: "in_progress",
        inboundCommentAt: new Date(now.getTime() - 700_000),
      }),
      await seedIssue({
        ...seeded,
        assigneeAgentId: seeded.conciergeAgentId,
        status: "in_progress",
        dingtalkConversationKey: null,
        inboundCommentAt: new Date(now.getTime() - 700_000),
      }),
      await seedIssue({
        ...seeded,
        assigneeAgentId: seeded.conciergeAgentId,
        status: "done",
        inboundCommentAt: new Date(now.getTime() - 700_000),
      }),
      await seedIssue({
        ...seeded,
        assigneeAgentId: seeded.conciergeAgentId,
        status: "in_progress",
        inboundCommentAt: new Date(now.getTime() - 300_000),
      }),
      await seedIssue({
        ...seeded,
        assigneeAgentId: seeded.conciergeAgentId,
        status: "in_progress",
        parentId,
        inboundCommentAt: new Date(now.getTime() - 700_000),
      }),
      await seedIssue({
        ...seeded,
        assigneeAgentId: seeded.conciergeAgentId,
        status: "in_progress",
        inboundCommentAt: null,
      }),
    ];

    const result = await svc().reconcileConciergeAnswerTimeout({
      now,
      conciergeAgentId: seeded.conciergeAgentId,
      timeoutMs: 600_000,
    });

    expect(result.fallbackPosted).toBe(0);
    expect(result.timedOut).toBe(0);
    for (const issueId of issueIds) {
      expect(await fallbackComments(issueId)).toHaveLength(0);
    }
  });

  it("does not post a duplicate fallback when the marker already exists after the anchor", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedCompany();
    const anchor = new Date(now.getTime() - 700_000);
    const issueId = await seedIssue({
      ...seeded,
      assigneeAgentId: seeded.conciergeAgentId,
      status: "in_progress",
      inboundCommentAt: anchor,
    });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId,
      authorUserId: "system",
      body: `${CONCIERGE_ANSWER_TIMEOUT_FALLBACK_MARKER}\n\nalready posted`,
      createdAt: new Date(anchor.getTime() + 60_000),
      updatedAt: new Date(anchor.getTime() + 60_000),
    });

    const result = await svc().reconcileConciergeAnswerTimeout({
      now,
      conciergeAgentId: seeded.conciergeAgentId,
      timeoutMs: 600_000,
    });

    expect(result).toMatchObject({
      timedOut: 1,
      fallbackPosted: 0,
      skippedIdempotent: 1,
    });
    expect(await fallbackComments(issueId)).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
  });

  it("uses the latest inbound user follow-up as the timeout anchor", async () => {
    const now = new Date("2026-04-22T20:00:00.000Z");
    const seeded = await seedCompany();
    const issueId = await seedIssue({
      ...seeded,
      assigneeAgentId: seeded.conciergeAgentId,
      status: "in_progress",
      inboundCommentAt: new Date(now.getTime() - 700_000),
      inboundBody: "first question",
    });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId,
      authorUserId: "ding-user-001",
      createdByRunId: null,
      body: "follow-up resets the anchor",
      createdAt: new Date(now.getTime() - 120_000),
      updatedAt: new Date(now.getTime() - 120_000),
    });

    const result = await svc().reconcileConciergeAnswerTimeout({
      now,
      conciergeAgentId: seeded.conciergeAgentId,
      timeoutMs: 600_000,
    });

    expect(result.fallbackPosted).toBe(0);
    expect(result.timedOut).toBe(0);
    expect(await fallbackComments(issueId)).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
  });
});
