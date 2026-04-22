import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileSelector,
} from "@paperclipai/shared";
import { api } from "./client";

export interface FileResourceQuery {
  path: string;
  workspace?: WorkspaceFileSelector;
}

function buildQuery(query: FileResourceQuery): string {
  const params = new URLSearchParams();
  params.set("path", query.path);
  if (query.workspace && query.workspace !== "auto") {
    params.set("workspace", query.workspace);
  }
  return params.toString();
}

export const fileResourcesApi = {
  resolve(issueId: string, query: FileResourceQuery): Promise<ResolvedWorkspaceResource> {
    return api.get<ResolvedWorkspaceResource>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/resolve?${buildQuery(query)}`,
    );
  },

  content(issueId: string, query: FileResourceQuery): Promise<WorkspaceFileContent> {
    return api.get<WorkspaceFileContent>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/content?${buildQuery(query)}`,
    );
  },
};
