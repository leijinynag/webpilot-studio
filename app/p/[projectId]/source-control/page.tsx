import { notFound } from "next/navigation";

import { AppShell } from "@/components/shell/app-shell";
import { SourceControlPage } from "@/components/source-control/source-control-page";

export default async function SourceControlRoute({
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
      <SourceControlPage />
    </AppShell>
  );
}
