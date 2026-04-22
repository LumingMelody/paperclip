import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import type { WorkspaceFileSelector } from "@paperclipai/shared";
import type { ParsedWorkspaceFileRef } from "@/lib/workspace-file-parser";

export interface FileViewerUrlState {
  path: string;
  line: number | null;
  column: number | null;
  workspace: WorkspaceFileSelector;
}

export interface FileViewerContextValue {
  issueId: string;
  /** Current viewer state derived from the URL, or null if closed. */
  state: FileViewerUrlState | null;
  open(ref: Pick<ParsedWorkspaceFileRef, "path" | "line" | "column"> & { workspace?: WorkspaceFileSelector }): void;
  close(): void;
}

const FileViewerContext = createContext<FileViewerContextValue | null>(null);

export function readFileViewerStateFromSearch(search: string): FileViewerUrlState | null {
  const params = new URLSearchParams(search);
  const path = params.get("file");
  if (!path) return null;
  const lineRaw = params.get("line");
  const columnRaw = params.get("column");
  const workspaceRaw = params.get("workspace");
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : NaN;
  const column = columnRaw ? Number.parseInt(columnRaw, 10) : NaN;
  const workspace = (workspaceRaw === "execution" || workspaceRaw === "project")
    ? workspaceRaw
    : "auto";
  return {
    path,
    line: Number.isFinite(line) && line > 0 ? line : null,
    column: Number.isFinite(column) && column > 0 ? column : null,
    workspace,
  };
}

export function writeFileViewerStateToSearch(current: string, next: FileViewerUrlState | null): string {
  const params = new URLSearchParams(current);
  if (!next) {
    params.delete("file");
    params.delete("line");
    params.delete("column");
    params.delete("workspace");
  } else {
    params.set("file", next.path);
    if (next.line !== null) params.set("line", String(next.line));
    else params.delete("line");
    if (next.column !== null) params.set("column", String(next.column));
    else params.delete("column");
    if (next.workspace && next.workspace !== "auto") params.set("workspace", next.workspace);
    else params.delete("workspace");
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

interface FileViewerProviderProps {
  issueId: string;
  children: ReactNode;
}

export function FileViewerProvider({ issueId, children }: FileViewerProviderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readFileViewerStateFromSearch(location.search), [location.search]);

  const open = useCallback<FileViewerContextValue["open"]>(
    (ref) => {
      const nextSearch = writeFileViewerStateToSearch(location.search, {
        path: ref.path,
        line: ref.line ?? null,
        column: ref.column ?? null,
        workspace: ref.workspace ?? "auto",
      });
      navigate(
        { pathname: location.pathname, hash: location.hash, search: nextSearch },
        { state: location.state, replace: false },
      );
    },
    [location.hash, location.pathname, location.search, location.state, navigate],
  );

  const close = useCallback(() => {
    const nextSearch = writeFileViewerStateToSearch(location.search, null);
    navigate(
      { pathname: location.pathname, hash: location.hash, search: nextSearch },
      { state: location.state, replace: false },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  const value = useMemo<FileViewerContextValue>(
    () => ({ issueId, state, open, close }),
    [issueId, state, open, close],
  );

  return <FileViewerContext.Provider value={value}>{children}</FileViewerContext.Provider>;
}

export function useFileViewer(): FileViewerContextValue | null {
  return useContext(FileViewerContext);
}

export function useRequiredFileViewer(): FileViewerContextValue {
  const ctx = useContext(FileViewerContext);
  if (!ctx) {
    throw new Error("useRequiredFileViewer must be used within a FileViewerProvider");
  }
  return ctx;
}
