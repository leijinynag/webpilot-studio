"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <div className="error-panel panel">
        <AlertTriangle />
        <div>
          <div className="eyebrow">Something went wrong</div>
          <h1 className="font-editorial">The workspace needs a reset.</h1>
          <p>当前页面没有完成渲染，可以尝试重新加载这一段工作区。</p>
          <Button onClick={reset} variant="outline">
            <RefreshCw />
            Try again
          </Button>
        </div>
      </div>
    </main>
  );
}
