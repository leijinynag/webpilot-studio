import { AppShell } from "@/components/shell/app-shell";
import { ShowcasePage } from "@/components/showcase/showcase-page";
import { listPublishedShowcaseCases } from "@/infrastructure/showcase/repository";

export const dynamic = "force-dynamic";

export default async function ShowcaseRoute() {
  const cases = await listPublishedShowcaseCases();

  return (
    <AppShell>
      <ShowcasePage cases={cases} />
    </AppShell>
  );
}
