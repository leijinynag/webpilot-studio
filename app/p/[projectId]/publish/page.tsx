import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { PublishPage } from "@/components/publish/publish-page";
import { loadOwnedProject } from "@/domains/project/server";

export default async function PublishRoute({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ admin?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const data = await loadOwnedProject(projectId);

  if (!data) {
    notFound();
  }

  return (
    <AppShell>
      <PublishPage adminMode={query.admin === "1"} project={data.project} />
    </AppShell>
  );
}
