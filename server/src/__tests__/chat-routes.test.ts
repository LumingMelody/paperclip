import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatRoutes } from "../routes/chat.ts";
import { errorHandler } from "../middleware/error-handler.ts";

function makeApp(handleIncoming: ReturnType<typeof vi.fn>) {
  const app = express();
  app.use(express.json());
  app.use(chatRoutes({ chatService: { handleIncoming } as any }));
  app.use(errorHandler);
  return app;
}

describe("POST /chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 with issueId/created for a new conversation", async () => {
    const handleIncoming = vi.fn().mockResolvedValue({ issueId: "issue-uuid", created: true });
    const app = makeApp(handleIncoming);

    const res = await request(app)
      .post("/chat")
      .send({ companyId: "c1", projectId: "p1", senderKey: "u1", text: "hello" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ issueId: "issue-uuid", created: true });
    expect(handleIncoming).toHaveBeenCalledOnce();
    expect(handleIncoming.mock.calls[0][0]).toMatchObject({
      companyId: "c1",
      projectId: "p1",
      senderKey: "u1",
      text: "hello",
    });
  });

  it("returns 400 when text is missing (ZodError via errorHandler)", async () => {
    const handleIncoming = vi.fn();
    const app = makeApp(handleIncoming);

    const res = await request(app)
      .post("/chat")
      .send({ companyId: "c1", projectId: "p1", senderKey: "u1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it("returns 500 when chat service throws", async () => {
    const handleIncoming = vi.fn().mockRejectedValue(new Error("boom"));
    const app = makeApp(handleIncoming);

    const res = await request(app)
      .post("/chat")
      .send({ companyId: "c1", projectId: "p1", senderKey: "u1", text: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/boom|chat service failure/);
  });
});
