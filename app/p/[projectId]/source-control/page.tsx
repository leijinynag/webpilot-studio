import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { SourceControlPage } from "@/components/source-control/source-control-page";
import { loadOwnedProject } from "@/domains/project/server";

export default async function SourceControlRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const data = await loadOwnedProject(projectId);

  if (!data) {
    notFound();
  }

  return (
    <AppShell>
      <SourceControlPage project={data.project} />
    </AppShell>
  );
}
