"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceFile } from "@/domains/project/workspace";
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
  return (
    <div aria-label="已打开文件" className="editor-tabs" role="tablist">
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
              {file.dirty ? <i aria-label="未保存" /> : null}
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`关闭 ${path}`}
                  onClick={() => onClose(path)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>关闭标签</TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
