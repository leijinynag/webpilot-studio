"use client";

import { useMemo, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Code2,
  File,
  FileCode2,
  FileJson,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Palette,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceFile } from "@/domains/project/workspace";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

type TreeDirectory = {
  type: "directory";
  name: string;
  path: string;
  children: TreeNode[];
};

type TreeFile = {
  type: "file";
  name: string;
  path: string;
  file: WorkspaceFile;
};

type TreeNode = TreeDirectory | TreeFile;

export function FileTree({
  activePath,
  files,
  onDelete,
  onOpen,
  onRename,
}: {
  activePath: string | null;
  files: Record<string, WorkspaceFile>;
  onDelete: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
}) {
  const tree = useMemo(() => buildFileTree(Object.values(files)), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { t } = useUiI18n();

  function toggleDirectory(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }

  return (
    <div
      aria-label={t("workbench.projectFiles")}
      className="file-tree"
      role="tree"
    >
      {tree.length > 0 ? (
        tree.map((node) => (
          <FileTreeNode
            activePath={activePath}
            collapsed={collapsed}
            depth={0}
            key={node.path}
            node={node}
            onDelete={onDelete}
            onOpen={onOpen}
            onRename={onRename}
            onToggle={toggleDirectory}
          />
        ))
      ) : (
        // 空 Repository 需要明确反馈，但这里不能偷偷创建示例文件或触发运行环境准备。
        <div className="file-tree-empty" role="status">
          <FilePlus2 aria-hidden="true" />
          <strong>{t("workbench.emptyFiles")}</strong>
          <span>{t("workbench.emptyFilesHint")}</span>
        </div>
      )}
    </div>
  );
}

function FileTreeNode({
  activePath,
  collapsed,
  depth,
  node,
  onDelete,
  onOpen,
  onRename,
  onToggle,
}: {
  activePath: string | null;
  collapsed: Set<string>;
  depth: number;
  node: TreeNode;
  onDelete: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const { t } = useUiI18n();
  const paddingLeft = 10 + depth * 14;

  if (node.type === "directory") {
    const isCollapsed = collapsed.has(node.path);

    return (
      <div aria-expanded={!isCollapsed} aria-selected={false} role="treeitem">
        <button
          className="file-tree-row file-tree-directory"
          onClick={() => onToggle(node.path)}
          style={{ paddingLeft }}
          type="button"
        >
          {isCollapsed ? <ChevronRight /> : <ChevronDown />}
          {isCollapsed ? <Folder /> : <FolderOpen />}
          <span>{node.name}</span>
        </button>
        {!isCollapsed ? (
          <div role="group">
            {node.children.map((child) => (
              <FileTreeNode
                activePath={activePath}
                collapsed={collapsed}
                depth={depth + 1}
                key={child.path}
                node={child}
                onDelete={onDelete}
                onOpen={onOpen}
                onRename={onRename}
                onToggle={onToggle}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      aria-selected={activePath === node.path}
      className={cn(
        "file-tree-row file-tree-file",
        activePath === node.path && "is-active",
      )}
      role="treeitem"
      style={{ paddingLeft }}
    >
      <button
        className="file-tree-open"
        onClick={() => onOpen(node.path)}
        type="button"
      >
        {getFileIcon(node.path)}
        <span>{node.name}</span>
        {node.file.dirty ? (
          <span aria-label={t("workbench.unsaved")} className="dirty-dot" />
        ) : null}
      </button>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`${node.path} ${t("workbench.fileActions")}`}
                className="file-tree-more"
                size="icon-xs"
                variant="ghost"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("workbench.fileActions")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => onRename(node.path)}>
              <Pencil />
              {t("workbench.renameFile")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onDelete(node.path)}
            >
              <Trash2 />
              {t("workbench.deleteFile")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function buildFileTree(files: WorkspaceFile[]): TreeNode[] {
  const root: TreeDirectory = {
    type: "directory",
    name: "",
    path: "",
    children: [],
  };

  for (const file of files.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const segments = file.path.split("/");
    let directory = root;

    for (const [index, segment] of segments.entries()) {
      const path = segments.slice(0, index + 1).join("/");
      const isFile = index === segments.length - 1;

      if (isFile) {
        directory.children.push({
          type: "file",
          name: segment,
          path,
          file,
        });
        continue;
      }

      let child = directory.children.find(
        (node): node is TreeDirectory =>
          node.type === "directory" && node.name === segment,
      );

      if (!child) {
        child = {
          type: "directory",
          name: segment,
          path,
          children: [],
        };
        directory.children.push(child);
      }

      directory = child;
    }
  }

  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]) {
  nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  for (const node of nodes) {
    if (node.type === "directory") {
      sortTree(node.children);
    }
  }
}

function getFileIcon(path: string) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) {
    return <Code2 />;
  }

  if (path.endsWith(".ts") || path.endsWith(".js")) {
    return <FileCode2 />;
  }

  if (path.endsWith(".json")) {
    return <FileJson />;
  }

  if (path.endsWith(".css") || path.endsWith(".scss")) {
    return <Palette />;
  }

  if (path.endsWith(".html")) {
    return <Braces />;
  }

  if (path.endsWith(".md") || path.endsWith(".txt")) {
    return <FileText />;
  }

  return <File />;
}
