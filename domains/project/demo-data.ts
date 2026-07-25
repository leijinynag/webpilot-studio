export const demoProjects = [
  {
    id: "atlas-finance",
    name: "Atlas Finance",
    description: "Analytics dashboard for independent teams",
    repository: "Browser Git",
    updatedAt: "2m ago",
    thumb: "finance",
  },
  {
    id: "northwind-notes",
    name: "Northwind Notes",
    description: "Minimal writing space with local search",
    repository: "Database",
    updatedAt: "Yesterday",
    thumb: "notes",
  },
  {
    id: "studio-archive",
    name: "Studio Archive",
    description: "Curated object catalogue and journal",
    repository: "Browser Git",
    updatedAt: "Jul 22",
    thumb: "store",
  },
] as const;

export const demoActivity = [
  {
    title: "Atlas Finance · Run 04 completed",
    detail: "3 files changed · 4 browser assertions passed · checkpoint saved",
    status: "success",
  },
  {
    title: "Studio Archive is waiting",
    detail:
      "Browser tab disconnected while preview was running. Reopen to resume.",
    status: "waiting",
  },
  {
    title: "Showcase published",
    detail: "Northwind Notes is now available at /showcase/northwind-notes",
    status: "success",
  },
] as const;

export const demoFiles = [
  { name: "src/App.tsx", status: "M", group: "Staged changes", staged: true },
  {
    name: "src/Dashboard.tsx",
    status: "M",
    group: "Changes",
    active: true,
  },
  { name: "src/styles.css", status: "M", group: "Changes" },
  { name: "src/RevenueCard.tsx", status: "U", group: "Untracked" },
] as const;
