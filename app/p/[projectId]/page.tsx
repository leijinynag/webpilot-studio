import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { WorkbenchPage } from "@/components/workbench/workbench-page";
import { loadOwnedProject } from "@/domains/project/server";

export default async function ProjectWorkbenchRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const data = await loadOwnedProject(projectId, { includeFiles: true });

  if (!data) {
    notFound();
  }

  return (
    <AppShell>
      <WorkbenchPage files={data.files} project={data.project} />
    </AppShell>
  );
}
