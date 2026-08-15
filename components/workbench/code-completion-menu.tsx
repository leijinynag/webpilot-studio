"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  codeCompletionStatusSchema,
  type CodeCompletionStatus,
} from "@/domains/code-completion/types";
import { browserApiFetch } from "@/infrastructure/http/browser-api";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

const CODE_COMPLETION_PREFERENCE_KEY = "webpilot:code-completion-preference:v1";

type CodeCompletionAvailability =
  "loading" | "configured" | "unconfigured" | "error";

type StoredCodeCompletionPreference = {
  version: 1;
  enabled: boolean;
};

type CodeCompletionStatusState = {
  projectId: string;
  availability: CodeCompletionAvailability;
  model: string | null;
};

export type CodeCompletionSettings = {
  availability: CodeCompletionAvailability;
  automaticEnabled: boolean;
  configured: boolean;
  model: string | null;
  preferenceEnabled: boolean;
  setPreferenceEnabled(enabled: boolean): void;
};

/**
 * 用户偏好与部署可用性是两层状态：
 *
 * - localStorage 只记录“用户是否愿意使用补全”，协议带版本号便于后续迁移；
 * - GET 接口只暴露模型名和是否配置完成，不把 API Key、Base URL 带到浏览器。
 *
 * 只有两者同时为 true 时才启用 Monaco Provider。这样线上未配置模型时不会
 * 因默认偏好开启而不断产生失败请求，配置恢复后也无需用户重新设置。
 */
export function useCodeCompletionSettings(
  projectId: string,
): CodeCompletionSettings {
  const [preferenceEnabled, setPreferenceEnabledState] = useState(
    () => readStoredPreference()?.enabled ?? true,
  );
  const [statusState, setStatusState] = useState<CodeCompletionStatusState>({
    projectId,
    availability: "loading",
    model: null,
  });
  // 项目切换后的首个 render 不能短暂沿用上一个项目的配置结果。通过把
  // projectId 放进异步状态并在读取时校验，可以派生 loading 状态，而无需
  // 在 effect 开头同步 setState 造成额外一轮级联渲染。
  const currentStatus =
    statusState.projectId === projectId
      ? statusState
      : {
          projectId,
          availability: "loading" as const,
          model: null,
        };

  useEffect(() => {
    const controller = new AbortController();

    void readCodeCompletionStatus(projectId, controller.signal).then(
      (status) => {
        if (controller.signal.aborted) {
          return;
        }
        setStatusState({
          projectId,
          model: status.model,
          availability: status.configured ? "configured" : "unconfigured",
        });
      },
      () => {
        if (!controller.signal.aborted) {
          setStatusState({
            projectId,
            availability: "error",
            model: null,
          });
        }
      },
    );

    return () => controller.abort();
  }, [projectId]);

  const setPreferenceEnabled = useCallback((enabled: boolean) => {
    const preference: StoredCodeCompletionPreference = {
      version: 1,
      enabled,
    };
    window.localStorage.setItem(
      CODE_COMPLETION_PREFERENCE_KEY,
      JSON.stringify(preference),
    );
    setPreferenceEnabledState(enabled);
  }, []);

  const configured = currentStatus.availability === "configured";

  return {
    availability: currentStatus.availability,
    automaticEnabled: preferenceEnabled && configured,
    configured,
    model: currentStatus.model,
    preferenceEnabled,
    setPreferenceEnabled,
  };
}

export function CodeCompletionMenu({
  activeFile,
  onTrigger,
  settings,
}: {
  activeFile: boolean;
  onTrigger: (() => void) | null;
  settings: CodeCompletionSettings;
}) {
  const { t } = useUiI18n();
  const pendingExplicitTriggerRef = useRef(false);
  const canTrigger = activeFile && settings.configured && onTrigger !== null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="code-completion-trigger-wrap">
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={t("workbench.codeCompletion.title")}
                className={cn(
                  "code-completion-trigger",
                  settings.automaticEnabled && "is-enabled",
                )}
                size="icon-sm"
                variant="ghost"
              >
                <Sparkles />
                <span
                  aria-hidden
                  className="code-completion-status-dot"
                  data-state={settings.availability}
                />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("workbench.codeCompletion.title")}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        align="end"
        className="code-completion-menu min-w-64"
        onCloseAutoFocus={(event) => {
          if (!pendingExplicitTriggerRef.current) {
            return;
          }

          // Radix 默认会在菜单关闭时把焦点还给触发按钮。显式补全需要让
          // Monaco 持续持有键盘焦点，否则建议虽然出现，Tab 却会被编辑器
          // 当作普通缩进。这里阻止默认回焦，并在弹层完成卸载后再启动补全。
          event.preventDefault();
          pendingExplicitTriggerRef.current = false;
          window.requestAnimationFrame(() => onTrigger?.());
        }}
      >
        <DropdownMenuLabel>
          {t("workbench.codeCompletion.title")}
        </DropdownMenuLabel>
        <div className="code-completion-model-status">
          <span
            aria-hidden
            className="code-completion-status-dot"
            data-state={settings.availability}
          />
          <span>{getAvailabilityLabel(settings.availability, t)}</span>
          {settings.model ? <code>{settings.model}</code> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={settings.preferenceEnabled}
          onCheckedChange={(checked) =>
            settings.setPreferenceEnabled(checked === true)
          }
          onSelect={(event) => event.preventDefault()}
        >
          {t("workbench.codeCompletion.automatic")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem
          disabled={!canTrigger}
          onSelect={() => {
            // onSelect 发生时菜单仍处于打开状态，只记录本次关闭的意图。
            // 真正触发点放在 onCloseAutoFocus，确保不会与 Radix 回焦竞争。
            pendingExplicitTriggerRef.current = true;
          }}
        >
          <Sparkles />
          {t("workbench.codeCompletion.trigger")}
          <DropdownMenuShortcut>Mod Alt Space</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function readCodeCompletionStatus(
  projectId: string,
  signal: AbortSignal,
): Promise<CodeCompletionStatus> {
  const response = await browserApiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/code-completions`,
    { signal },
  );
  if (!response.ok) {
    throw new Error("代码补全状态读取失败。");
  }
  return codeCompletionStatusSchema.parse(await response.json());
}

function readStoredPreference(): StoredCodeCompletionPreference | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const raw = window.localStorage.getItem(CODE_COMPLETION_PREFERENCE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<StoredCodeCompletionPreference>;
    return value.version === 1 && typeof value.enabled === "boolean"
      ? { version: 1, enabled: value.enabled }
      : null;
  } catch {
    // localStorage 可能被隐私模式禁用或留下损坏数据。偏好读取失败时保持默认
    // 开启，但服务端可用性仍是硬门槛，不会因此发出无效补全请求。
    return null;
  }
}

function getAvailabilityLabel(
  availability: CodeCompletionAvailability,
  t: ReturnType<typeof useUiI18n>["t"],
): string {
  return t(`workbench.codeCompletion.status.${availability}`);
}
