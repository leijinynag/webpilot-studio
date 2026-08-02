import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getMessages } from "@/infrastructure/i18n/messages";
import { getRequestLocale } from "@/infrastructure/i18n/request-locale";

export default async function NotFound() {
  // not-found 是服务端特殊页面，不能调用客户端国际化 Hook。
  // 直接按请求解析 locale，确保 404 页面也能跟随语言 Cookie 和请求头。
  const locale = await getRequestLocale();
  const messages = getMessages(locale);
  const copy = messages.errors;

  return (
    <main className="error-page">
      <div className="error-panel panel">
        <div>
          <div className="eyebrow">{copy.notFoundEyebrow}</div>
          <h1 className="font-editorial">{copy.notFoundTitle}</h1>
          <p>{copy.notFoundDescription}</p>
          <Button asChild className="app-button-accent">
            <Link href="/">
              <ArrowLeft data-icon="inline-start" />
              {copy.backToProjects}
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
