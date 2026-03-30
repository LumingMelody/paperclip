import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";
import { serverVersion } from "../version.js";

vi.mock("../dev-server-status.js", async () => {
  const actual = await vi.importActual<typeof import("../dev-server-status.js")>(
    "../dev-server-status.js",
  );
  return {
    ...actual,
    readPersistedDevServerStatus: () => null,
  };
});

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = express();
    app.use("/health", healthRoutes());
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  });

  it("checks database connectivity before reporting healthy", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const app = express();
    app.use("/health", healthRoutes({ execute } as any));

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const app = express();
    app.use(
      "/health",
      healthRoutes({
        execute: vi.fn().mockRejectedValue(new Error("db offline")),
      } as any),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "error",
      error: "Database unavailable",
      version: serverVersion,
    });
  });
});
