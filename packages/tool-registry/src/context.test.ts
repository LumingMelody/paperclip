import { describe, expect, it } from "vitest";
import { assertContext } from "./context.js";
import { ValidationError } from "./errors.js";

const hash = "a".repeat(64);

describe("assertContext", () => {
  it("accepts a complete execution context", () => {
    expect(
      assertContext({
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        actor: "agent",
        toolName: "lingxing.factSku",
        argsHash: hash,
      }),
    ).toEqual({
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      actor: "agent",
      toolName: "lingxing.factSku",
      argsHash: hash,
    });
  });

  it("rejects missing required context fields", () => {
    expect(() =>
      assertContext({
        companyId: "company-1",
        projectId: "project-1",
        issueId: "issue-1",
        toolName: "lingxing.factSku",
        argsHash: hash,
      }),
    ).toThrow(ValidationError);
  });
});
