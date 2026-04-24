// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import type { TranscriptEntry } from "../../adapters";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView, normalizeTranscript } from "./RunTranscriptView";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("RunTranscriptView", () => {
  it("keeps running command stdout inside the command fold instead of a standalone stdout block", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-03-12T00:00:00.000Z",
        name: "command_execution",
        toolUseId: "cmd_1",
        input: { command: "ls -la" },
      },
      {
        kind: "stdout",
        ts: "2026-03-12T00:00:01.000Z",
        text: "file-a\nfile-b",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "command_group",
      items: [{ result: "file-a\nfile-b", status: "running" }],
    });
  });

  it("renders assistant and thinking content as markdown in compact mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "assistant",
              ts: "2026-03-12T00:00:00.000Z",
              text: "Hello **world**",
            },
            {
              kind: "thinking",
              ts: "2026-03-12T00:00:01.000Z",
              text: "- first\n- second",
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("<strong>world</strong>");
    expect(html).toMatch(/<li[^>]*>first<\/li>/);
    expect(html).toMatch(/<li[^>]*>second<\/li>/);
  });

  it("hides saved-session resume skip stderr from nice mode normalization", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-03-12T00:00:00.000Z",
        text: "[paperclip] Skipping saved session resume for task \"PAP-485\" because wake reason is issue_assigned.",
      },
      {
        kind: "assistant",
        ts: "2026-03-12T00:00:01.000Z",
        text: "Working on the task.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "message",
      role: "assistant",
      text: "Working on the task.",
    });
  });

  it("renders successful result summaries as markdown in nice mode", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <RunTranscriptView
          density="compact"
          entries={[
            {
              kind: "result",
              ts: "2026-03-12T00:00:02.000Z",
              text: "## Summary\n\n- fixed deploy config\n- posted issue update",
              inputTokens: 10,
              outputTokens: 20,
              cachedTokens: 0,
              costUsd: 0,
              subtype: "success",
              isError: false,
              errors: [],
            },
          ]}
        />
      </ThemeProvider>,
    );

    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toMatch(/<li[^>]*>fixed deploy config<\/li>/);
    expect(html).toMatch(/<li[^>]*>posted issue update<\/li>/);
    expect(html).not.toContain("result");
  });

  it("adds timestamp and age tooltip to raw mode labels lazily on hover", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T00:03:00.000Z"));
    const { container, unmount } = render(
      <ThemeProvider>
        <RunTranscriptView
          mode="raw"
          entries={[
            {
              kind: "stdout",
              ts: "2026-03-12T00:00:00.000Z",
              text: "hello",
            },
          ]}
        />
      </ThemeProvider>,
    );
    try {
      const label = container.querySelector("span[data-timestamp]");
      expect(label?.textContent).toBe("stdout");
      expect(label?.getAttribute("title")).toBeNull();

      act(() => {
        label?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });

      expect(label?.getAttribute("title")).toContain("Timestamp:");
      expect(label?.getAttribute("title")).toContain("Ago: 3m ago");
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});
