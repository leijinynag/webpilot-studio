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
import { useUiI18n } from "@/infrastructure/i18n/ui";

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
  const { t } = useUiI18n();
  const [value, setValue] = useState(initialValue);

  const copy = {
    create: {
      title: t("workbench.fileOperation.createTitle"),
      description: t("workbench.fileOperation.createDescription"),
      confirm: t("workbench.fileOperation.createConfirm"),
    },
    rename: {
      title: t("workbench.fileOperation.renameTitle"),
      description: t("workbench.fileOperation.renameDescription"),
      confirm: t("workbench.fileOperation.renameConfirm"),
    },
    delete: {
      title: t("workbench.fileOperation.deleteTitle"),
      description: t("workbench.fileOperation.deleteDescription", {
        path: initialValue,
      }),
      confirm: t("workbench.fileOperation.deleteConfirm"),
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
              aria-label={t("workbench.fileOperation.pathLabel")}
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
              {t("common.cancel")}
            </Button>
            <Button
              disabled={pending || (mode !== "delete" && value.trim() === "")}
              type="submit"
              variant={mode === "delete" ? "destructive" : "default"}
            >
              {pending ? t("workbench.fileOperation.processing") : copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
