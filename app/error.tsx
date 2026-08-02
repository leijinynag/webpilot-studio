"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUiI18n } from "@/infrastructure/i18n/ui";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useUiI18n();

  return (
    <main className="error-page">
      <div className="error-panel panel">
        <AlertTriangle />
        <div>
          <div className="eyebrow">{t("errors.somethingWrong")}</div>
          <h1 className="font-editorial">{t("errors.errorTitle")}</h1>
          <p>{t("errors.errorDescription")}</p>
          <Button onClick={reset} variant="outline">
            <RefreshCw />
            {t("errors.tryAgain")}
          </Button>
        </div>
      </div>
    </main>
  );
}
