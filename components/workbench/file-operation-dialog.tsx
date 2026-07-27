"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function FileOperationDialog({
  initialValue,
  mode,
  onOpenChange,
  onSubmit,
  open,
  pending,
}: {
  initialValue: string;
  mode: "create" | "rename" | "delete";
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => void;
  open: boolean;
  pending: boolean;
}) {
  const [value, setValue] = useState(initialValue);

  const copy = {
    create: {
      title: "新建文件",
      description: "输入项目内的完整相对路径。",
      confirm: "创建",
    },
    rename: {
      title: "重命名文件",
      description: "修改完整相对路径，目录不存在时会由运行镜像自动创建。",
      confirm: "重命名",
    },
    delete: {
      title: "删除文件",
      description: `确认删除 ${initialValue}？此操作会创建新的 Repository revision。`,
      confirm: "删除",
    },
  }[mode];

  function submit(event: React.FormEvent) {
    event.preventDefault();
    onSubmit(value.trim());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          {mode !== "delete" ? (
            <Input
              aria-label="文件路径"
              autoFocus
              className="file-dialog-input"
              onChange={(event) => setValue(event.target.value)}
              placeholder="src/components/example.tsx"
              value={value}
            />
          ) : null}
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={pending || (mode !== "delete" && value.trim() === "")}
              type="submit"
              variant={mode === "delete" ? "destructive" : "default"}
            >
              {pending ? "处理中..." : copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
