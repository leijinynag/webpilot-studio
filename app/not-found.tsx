import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="error-page">
      <div className="error-panel panel">
        <div>
          <div className="eyebrow">404 / Not found</div>
          <h1 className="font-editorial">This project is still a thought.</h1>
          <p>找不到这个页面或项目。返回工作区继续浏览现有的演示页面。</p>
          <Button asChild className="app-button-accent">
            <Link href="/">
              <ArrowLeft data-icon="inline-start" />
              Back to projects
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
