import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { PublishPage } from "@/components/publish/publish-page";

export default async function PublishRoute({
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
      <PublishPage />
    </AppShell>
  );
}
