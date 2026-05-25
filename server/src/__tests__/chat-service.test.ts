import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatService } from "../services/chat.ts";

/**
 * Tests for chatService.handleIncoming — chat-as-issue conversation container.
 *
 * Two paths:
 *   A. No open issue for senderKey → create new issue + add user comment + wakeup
 *   B. Open issue exists (status not done/cancelled) → append comment + wakeup
 */

interface ChainMock {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
}

function createSelectChain(rows: unknown[]): ChainMock {
  const chain: ChainMock = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows) as any),
    values: vi.fn(),
    returning: vi.fn(),
  };
  return chain;
}

function createInsertChain(returningRows: unknown[]): ChainMock {
  const chain: ChainMock = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    values: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve(returningRows) as any),
  };
  return chain;
}

function createFakeDb(opts: {
  existingIssues: unknown[];
  newIssueId: string;
}) {
  const selectChain = createSelectChain(opts.existingIssues);
  const insertIssueChain = createInsertChain([{ id: opts.newIssueId }]);
  const insertCommentChain = createInsertChain([]);

  const insertCalls: any[] = [];
  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn((table: unknown) => {
      insertCalls.push(table);
      // First insert = issue, second insert = comment
      return insertCalls.length === 1 ? insertIssueChain : insertCommentChain;
    }),
  };

  return { db, selectChain, insertIssueChain, insertCommentChain, insertCalls };
}

describe("chatService.handleIncoming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a new issue when no open conversation exists", async () => {
    const { db } = createFakeDb({
      existingIssues: [],
      newIssueId: "issue-new-001",
    });
    const wakeup = vi.fn().mockResolvedValue(undefined);

    const svc = chatService({
      db: db as any,
      conciergeAgentId: "concierge-agent-uuid",
      wakeup,
      heartbeat: {} as any,
    });

    const result = await svc.handleIncoming({
      companyId: "co-1",
      projectId: "proj-1",
      senderKey: "ding-user-001",
      text: "EE02968 顾客主要抱怨什么",
    });

    expect(result.issueId).toBe("issue-new-001");
    expect(result.created).toBe(true);
    // Insert called twice: once for issue, once for comment
    expect(db.insert).toHaveBeenCalledTimes(2);
    // Wakeup fired with the new issue id + concierge assignee
    expect(wakeup).toHaveBeenCalledOnce();
    const wakeupArg = wakeup.mock.calls[0][0];
    expect(wakeupArg.issue.id).toBe("issue-new-001");
    expect(wakeupArg.issue.assigneeAgentId).toBe("concierge-agent-uuid");
  });

  it("appends a comment to existing open issue when conversationKey matches", async () => {
    const { db } = createFakeDb({
      existingIssues: [
        { id: "issue-existing-042", status: "in_progress", assigneeAgentId: "concierge-agent-uuid" },
      ],
      newIssueId: "should-not-be-used",
    });
    const wakeup = vi.fn().mockResolvedValue(undefined);

    const svc = chatService({
      db: db as any,
      conciergeAgentId: "concierge-agent-uuid",
      wakeup,
      heartbeat: {} as any,
    });

    const result = await svc.handleIncoming({
      companyId: "co-1",
      projectId: "proj-1",
      senderKey: "ding-user-001",
      text: "follow-up: 那 EE02960 呢",
    });

    expect(result.issueId).toBe("issue-existing-042");
    expect(result.created).toBe(false);
    // Only one insert (the comment); no issue insert
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledOnce();
  });
});
