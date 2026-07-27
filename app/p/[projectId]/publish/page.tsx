import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { PublishPage } from "@/components/publish/publish-page";
import { loadOwnedProject } from "@/domains/project/server";

export default async function PublishRoute({
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
      <PublishPage project={data.project} />
    </AppShell>
  );
}
