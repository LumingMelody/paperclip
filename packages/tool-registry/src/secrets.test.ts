import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsNotConfigured } from "./errors.js";

const mockHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.value,
  };
});

const { loadCompanySecrets } = await import("./secrets.js");

describe("loadCompanySecrets", () => {
  beforeEach(async () => {
    mockHome.value = await fs.mkdtemp(path.join(tmpdir(), "tool-registry-secrets-"));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it("loads source secrets for a company from ~/.paperclip/tool-secrets.json", async () => {
    await fs.mkdir(path.join(mockHome.value, ".paperclip"), { recursive: true });
    await fs.writeFile(
      path.join(mockHome.value, ".paperclip", "tool-secrets.json"),
      JSON.stringify({
        companies: {
          "company-1": {
            lingxing: {
              host: "db.example.test",
              port: 1433,
              user: "readonly",
              password: "p",
              database: "everpretty",
            },
          },
        },
      }),
    );

    await expect(loadCompanySecrets("company-1", "lingxing")).resolves.toEqual({
      host: "db.example.test",
      port: "1433",
      user: "readonly",
      password: "p",
      database: "everpretty",
    });
  });

  it("throws SecretsNotConfigured when the file or company is missing", async () => {
    await expect(loadCompanySecrets("company-1", "lingxing")).rejects.toThrow(SecretsNotConfigured);

    await fs.mkdir(path.join(mockHome.value, ".paperclip"), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, ".paperclip", "tool-secrets.json"), JSON.stringify({ companies: {} }));

    await expect(loadCompanySecrets("company-1", "lingxing")).rejects.toThrow(SecretsNotConfigured);
  });
});
