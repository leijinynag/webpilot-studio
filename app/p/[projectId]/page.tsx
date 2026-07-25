import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { WorkbenchPage } from "@/components/workbench/workbench-page";

export default async function ProjectWorkbenchRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  if (projectId !== "atlas-finance") {
    notFound();
  }

  return (
    <AppShell>
      <WorkbenchPage />
    </AppShell>
  );
}
