"use client";

import { CircleCheck, LoaderCircle, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { StreamingFileProjectionStatus } from "@/domains/agent/streaming-file-projection";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

export type EditorTabItem =
  | {
      id: string;
      kind: "repository";
      path: string;
      dirty: boolean;
    }
  | {
      id: string;
      kind: "streaming";
      path: string;
      status: StreamingFileProjectionStatus;
    };

export function EditorTabs({
  activeId,
  onClose,
  onSelect,
  tabs,
}: {
  activeId: string | null;
  onClose: (id: string) => void;
  onSelect: (id: string) => void;
  tabs: readonly EditorTabItem[];
}) {
  const { t } = useUiI18n();

  return (
    <div
      aria-label={t("workbench.openedFiles")}
      className="editor-tabs"
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = activeId === tab.id;
        return (
          <div
            aria-selected={active}
            className={cn(
              "editor-tab",
              active && "is-active",
              tab.kind === "streaming" && "is-streaming",
            )}
            key={tab.id}
            role="tab"
          >
            <button onClick={() => onSelect(tab.id)} type="button">
              <span>{tab.path.split("/").at(-1)}</span>
              {tab.kind === "repository" && tab.dirty ? (
                <i aria-label={t("workbench.unsaved")} />
              ) : null}
              {tab.kind === "streaming" ? (
                <span
                  aria-label={getStreamingStatusLabel(tab.status, t)}
                  className={cn(
                    "editor-tab-streaming-status",
                    tab.status === "streaming" && "is-generating",
                  )}
                >
                  {tab.status === "streaming" ? (
                    <LoaderCircle />
                  ) : (
                    <CircleCheck />
                  )}
                </span>
              ) : null}
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("workbench.closeFile", { path: tab.path })}
                  onClick={() => onClose(tab.id)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("workbench.closeTabTooltip")}</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}

function getStreamingStatusLabel(
  status: StreamingFileProjectionStatus,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  return t(
    status === "streaming"
      ? "workbench.streamingFile.generating"
      : status === "completed"
        ? "workbench.streamingFile.validating"
        : "workbench.streamingFile.syncing",
  );
}
