"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Database,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BrowserGitMigrationRecoveryRequiredError,
  createBrowserGitMigrationController,
  type BrowserGitMigrationController,
  type BrowserGitMigrationStage,
} from "@/domains/project/browser-git-migration-client";
import type { ProjectDescription } from "@/domains/project/types";
import { cn } from "@/lib/utils";

const MIGRATION_STEPS: {
  stage: BrowserGitMigrationStage;
  label: string;
}[] = [
  { stage: "preparing", label: "冻结 Database revision 并导出源码" },
  { stage: "creating_candidate", label: "创建本地 candidate 与 initial commit" },
  { stage: "validating_candidate", label: "校验文件清单、HEAD 与 clean 状态" },
  { stage: "promoting", label: "复制为当前项目的正式 Browser Git 仓库" },
  { stage: "finalizing", label: "原子切换项目存储类型" },
];

type DialogStatus = "idle" | "running" | "success" | "error";

export function BrowserGitMigrationDialog({
  dirtyPaths,
  project,
  controller,
}: {
  dirtyPaths: readonly string[];
  project: ProjectDescription;
  controller?: BrowserGitMigrationController;
}) {
  const router = useRouter();
  const controllerRef = useRef(
    controller ?? createBrowserGitMigrationController(),
  );
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DialogStatus>("idle");
  const [stage, setStage] = useState<BrowserGitMigrationStage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const hasDirtyDrafts = dirtyPaths.length > 0;
  const pending = status === "running";

  async function startMigration() {
    if (hasDirtyDrafts || pending) {
      return;
    }

    setStatus("running");
    setErrorMessage(null);
    setRecoveryRequired(false);

    try {
      if (controllerRef.current.canRecover) {
        await controllerRef.current.recover({
          projectId: project.id,
          onStage: setStage,
        });
      } else {
        await controllerRef.current.migrate({
          project,
          onStage: setStage,
        });
      }
      setStatus("success");
      setStage("completed");

      // 成功提示需要保留到用户确认，不能在这里立即 refresh。
      // 如果 Server Component 立刻重挂载，用户会看不到迁移结果，且可能误以为
      // 迁移仍在等待。点击“完成”时再刷新，下一次进入 Source Control 就会读取
      // 已经原子切换后的 storageKind。
    } catch (error) {
      setStatus("error");
      setRecoveryRequired(
        error instanceof BrowserGitMigrationRecoveryRequiredError,
      );
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "迁移失败，Database Repository 仍保持可用。",
      );
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (pending) {
      return;
    }

    setOpen(nextOpen);
    if (!nextOpen && status === "success") {
      // 迁移已经在服务端完成，关闭结果对话框后刷新工作台的项目描述。
      router.refresh();
    }
    if (!nextOpen && status !== "success") {
      setStage(null);
      setStatus("idle");
      setErrorMessage(null);
      setRecoveryRequired(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="outline"
      >
        <GitBranch data-icon="inline-start" />
        Migrate
      </Button>

      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogContent
          className="browser-git-migration-dialog"
          showCloseButton={!pending}
        >
          <DialogHeader>
            <div className="browser-git-migration-heading">
              <div className="browser-git-migration-mark">
                <Database />
                <span />
                <GitBranch />
              </div>
              <Badge variant="outline">Database to Browser Git</Badge>
            </div>
            <DialogTitle>迁移到 Browser Git</DialogTitle>
            <DialogDescription>
              源码将从服务端 Database 复制到当前浏览器的 IndexedDB，并创建可
              stage、commit 和查看历史的本地 Git 仓库。
            </DialogDescription>
          </DialogHeader>

          <section
            aria-label="Browser Git 本地存储风险"
            className="browser-git-migration-risk"
          >
            <AlertTriangle />
            <div>
              <b>迁移后源码只保存在这个浏览器</b>
              <p>
                清理站点数据或更换设备会丢失本地仓库。迁移不会自动配置 remote，
                也不会执行 push、pull 或 fetch。
              </p>
            </div>
          </section>

          {hasDirtyDrafts ? (
            <section
              aria-label="未保存草稿阻止迁移"
              className="browser-git-migration-drafts"
            >
              <b>{dirtyPaths.length} 个 Monaco 草稿尚未保存</b>
              <p>请先保存或放弃这些草稿，再开始迁移。</p>
              <ul>
                {dirtyPaths.slice(0, 4).map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </section>
          ) : (
            <ol className="browser-git-migration-steps">
              {MIGRATION_STEPS.map((item, index) => {
                const currentIndex = stage
                  ? MIGRATION_STEPS.findIndex(
                      (candidate) => candidate.stage === stage,
                    )
                  : -1;
                const complete =
                  status === "success" ||
                  (currentIndex >= 0 && index < currentIndex);
                const active =
                  stage === item.stage ||
                  (stage === "recovering" && item.stage === "finalizing");

                return (
                  <li
                    className={cn(
                      complete && "is-complete",
                      active && "is-active",
                    )}
                    key={item.stage}
                  >
                    {complete ? (
                      <Check />
                    ) : active && pending ? (
                      <LoaderCircle className="browser-git-migration-spinner" />
                    ) : (
                      <CircleDashed />
                    )}
                    <span>{item.label}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {errorMessage ? (
            <div className="browser-git-migration-result is-error" role="alert">
              <b>
                {recoveryRequired ? "需要确认迁移状态" : "迁移未完成"}
              </b>
              <p>{errorMessage}</p>
            </div>
          ) : null}

          {status === "success" ? (
            <div
              className="browser-git-migration-result is-success"
              role="status"
            >
              <Check />
              <div>
                <b>迁移完成</b>
                <p>工作台正在切换到当前浏览器中的 Browser Git 仓库。</p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => handleOpenChange(false)}
              type="button"
              variant="outline"
            >
              {status === "success" ? "完成" : "取消"}
            </Button>
            {status !== "success" ? (
              <Button
                disabled={hasDirtyDrafts || pending}
                onClick={startMigration}
                type="button"
              >
                {recoveryRequired ? (
                  <RefreshCw data-icon="inline-start" />
                ) : (
                  <GitBranch data-icon="inline-start" />
                )}
                {pending
                  ? stage === "recovering"
                    ? "正在确认状态"
                    : "正在迁移"
                  : recoveryRequired
                    ? "重试确认"
                    : status === "error"
                      ? "重新迁移"
                      : "开始迁移"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
