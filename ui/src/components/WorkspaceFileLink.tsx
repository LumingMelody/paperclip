import type { MouseEvent, ReactNode } from "react";
import { FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedWorkspaceFileRef } from "@/lib/workspace-file-parser";
import { formatWorkspaceFileRefDisplay } from "@/lib/workspace-file-parser";
import { useFileViewer } from "@/context/FileViewerContext";

export interface WorkspaceFileLinkProps {
  workspaceFileRef: ParsedWorkspaceFileRef;
  /** Override the rendered label. Defaults to `path:line:col`. */
  label?: ReactNode;
  className?: string;
  /** Optional override if the consumer wants to customize activation. */
  onOpen?: (ref: ParsedWorkspaceFileRef) => void;
  showIcon?: boolean;
  title?: string;
}

export function WorkspaceFileLink({
  workspaceFileRef,
  label,
  className,
  onOpen,
  showIcon = true,
  title,
}: WorkspaceFileLinkProps) {
  const viewer = useFileViewer();
  const display = typeof label !== "undefined" ? label : formatWorkspaceFileRefDisplay(workspaceFileRef);
  const canOpen = !!(onOpen || viewer);
  const lineSuffix = workspaceFileRef.line
    ? ` line ${workspaceFileRef.line}${workspaceFileRef.column ? ` column ${workspaceFileRef.column}` : ""}`
    : "";
  const ariaLabel = canOpen
    ? `Open ${workspaceFileRef.path}${lineSuffix} in the file viewer`
    : `Workspace file ${workspaceFileRef.path}${lineSuffix}`;
  const tooltip = title ?? (canOpen
    ? `Open ${workspaceFileRef.path}${lineSuffix} in the file viewer`
    : `Workspace file ${workspaceFileRef.path}${lineSuffix}`);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (!canOpen) return;
    event.preventDefault();
    if (onOpen) onOpen(workspaceFileRef);
    else viewer?.open(workspaceFileRef);
  };

  return (
    <a
      href="#"
      role={canOpen ? "button" : undefined}
      data-workspace-file-link="true"
      data-workspace-file-path={workspaceFileRef.path}
      aria-label={ariaLabel}
      title={tooltip}
      className={cn(
        "paperclip-workspace-file-link inline-flex items-center gap-1 rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[0.78em] leading-tight text-foreground/90 align-baseline no-underline hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
      onClick={handleClick}
    >
      {showIcon ? <FileCode2 aria-hidden="true" className="h-3 w-3 shrink-0 opacity-70" /> : null}
      <span className="truncate max-w-[38ch]">{display}</span>
    </a>
  );
}
