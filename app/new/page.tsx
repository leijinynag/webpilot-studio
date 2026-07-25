import { AppShell } from "@/components/shell/app-shell";
import { NewProjectPage } from "@/components/projects/new-project-page";

export default function NewProjectRoute() {
  return (
    <AppShell>
      <NewProjectPage />
    </AppShell>
  );
}
