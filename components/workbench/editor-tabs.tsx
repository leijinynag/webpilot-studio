"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceFile } from "@/domains/project/workspace";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

export function EditorTabs({
  activePath,
  files,
  openPaths,
  onClose,
  onSelect,
}: {
  activePath: string | null;
  files: Record<string, WorkspaceFile>;
  openPaths: string[];
  onClose: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const { t } = useUiI18n();

  return (
    <div
      aria-label={t("workbench.openedFiles")}
      className="editor-tabs"
      role="tablist"
    >
      {openPaths.map((path) => {
        const file = files[path];

        if (!file) {
          return null;
        }

        return (
          <div
            aria-selected={activePath === path}
            className={cn("editor-tab", activePath === path && "is-active")}
            key={path}
            role="tab"
          >
            <button onClick={() => onSelect(path)} type="button">
              <span>{path.split("/").at(-1)}</span>
              {file.dirty ? <i aria-label={t("workbench.unsaved")} /> : null}
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("workbench.closeFile", { path })}
                  onClick={() => onClose(path)}
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
