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
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

const MIGRATION_STEPS: {
  stage: BrowserGitMigrationStage;
}[] = [
  { stage: "preparing" },
  { stage: "creating_candidate" },
  { stage: "validating_candidate" },
  { stage: "promoting" },
  { stage: "finalizing" },
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
  const { t } = useUiI18n();
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
          : t("workbench.browserGitMigration.failed"),
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
        {t("workbench.browserGitMigration.open")}
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
              <Badge variant="outline">
                {t("workbench.browserGitMigration.badge")}
              </Badge>
            </div>
            <DialogTitle>
              {t("workbench.browserGitMigration.title")}
            </DialogTitle>
            <DialogDescription>
              {t("workbench.browserGitMigration.description")}
            </DialogDescription>
          </DialogHeader>

          <section
            aria-label={t("workbench.browserGitMigration.riskLabel")}
            className="browser-git-migration-risk"
          >
            <AlertTriangle />
            <div>
              <b>{t("workbench.browserGitMigration.riskTitle")}</b>
              <p>{t("workbench.browserGitMigration.riskDescription")}</p>
            </div>
          </section>

          {hasDirtyDrafts ? (
            <section
              aria-label={t("workbench.browserGitMigration.draftsLabel")}
              className="browser-git-migration-drafts"
            >
              <b>
                {t("workbench.browserGitMigration.draftsTitle", {
                  count: dirtyPaths.length,
                })}
              </b>
              <p>{t("workbench.browserGitMigration.draftsDescription")}</p>
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
                    <span>
                      {t(`workbench.browserGitMigration.steps.${item.stage}`)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {errorMessage ? (
            <div className="browser-git-migration-result is-error" role="alert">
              <b>
                {recoveryRequired
                  ? t("workbench.browserGitMigration.recoveryTitle")
                  : t("workbench.browserGitMigration.errorTitle")}
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
                <b>{t("workbench.browserGitMigration.successTitle")}</b>
                <p>{t("workbench.browserGitMigration.successDescription")}</p>
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
              {status === "success"
                ? t("workbench.browserGitMigration.done")
                : t("common.cancel")}
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
                    ? t("workbench.browserGitMigration.confirming")
                    : t("workbench.browserGitMigration.migrating")
                  : recoveryRequired
                    ? t("workbench.browserGitMigration.retryConfirm")
                    : status === "error"
                      ? t("workbench.browserGitMigration.retry")
                      : t("workbench.browserGitMigration.start")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
