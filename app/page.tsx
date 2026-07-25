import { AppShell } from "@/components/shell/app-shell";
import { ProjectsPage } from "@/components/projects/projects-page";

export default function Home() {
  return (
    <AppShell>
      <ProjectsPage />
    </AppShell>
  );
}
