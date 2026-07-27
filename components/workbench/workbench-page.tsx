import Link from "next/link";
import { ExternalLink, Send, Square } from "lucide-react";

import { WebContainerPreview } from "@/components/preview/webcontainer-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  ProjectDescription,
  ProjectFileSnapshot,
} from "@/domains/project/types";

export function WorkbenchPage({
  files,
  project,
}: {
  files: readonly ProjectFileSnapshot[];
  project: ProjectDescription;
}) {
  return (
    <div className="workbench-page page-in">
      <div className="workbench-top">
        <div className="project-crumb">
          <span>Projects</span>
          <span>/</span>
          <b>{project.name}</b>
          <span>Revision {project.revision}</span>
        </div>
        <ToggleGroup
          aria-label="工作台视图"
          className="workbench-tabs"
          defaultValue="preview"
          type="single"
        >
          <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
          <ToggleGroupItem value="code">Code</ToggleGroupItem>
          <ToggleGroupItem asChild value="changes">
            <Link href={`/p/${project.id}/source-control`}>
              Changes <Badge variant="outline">3</Badge>
            </Link>
          </ToggleGroupItem>
          <ToggleGroupItem value="tests">Tests</ToggleGroupItem>
        </ToggleGroup>
        <div className="workbench-actions">
          <Button asChild size="sm" variant="outline">
            <Link href={`/p/${project.id}/source-control`}>Source Control</Link>
          </Button>
          <Button size="sm" variant="ghost">
            Export
          </Button>
          <Button asChild className="app-button-accent" size="sm">
            <Link href={`/p/${project.id}/publish`}>
              <ExternalLink data-icon="inline-start" />
              Publish
            </Link>
          </Button>
        </div>
      </div>

      <div className="workbench-grid">
        <aside className="agent-panel">
          <div className="agent-scroll">
            <div className="conversation-name">
              <b>Dashboard refinement</b>
              <span>Run 04 · 01:42</span>
            </div>
            <div className="message user">
              <div className="message-role">You</div>
              <p>
                Make the opening calmer and more editorial. Add a compact
                revenue comparison and verify the primary flow.
              </p>
            </div>
            <div className="message">
              <div className="message-role">WebPilot</div>
              <p>
                I&apos;ve reorganized the overview around three key metrics and
                reduced the visual noise. I&apos;m running the project now, then
                I&apos;ll replay the dashboard smoke flow.
              </p>
              <div className="agent-run">
                <AgentStep label="Read project structure" meta="12 files" />
                <AgentStep label="Update Dashboard.tsx" meta="+84 −37" />
                <AgentStep label="Start preview server" meta="612ms" />
                <AgentStep label="Replay primary flow" meta="3 / 4" running />
              </div>
            </div>
          </div>
          <div className="agent-composer">
            <div className="agent-composer-box">
              <span>Ask WebPilot to change, inspect, or verify…</span>
              <div className="agent-composer-tools">
                <span>
                  <PlusText />
                  Attach&nbsp;&nbsp; @ Context
                </span>
                <span>
                  Stop <Square />
                </span>
              </div>
            </div>
          </div>
        </aside>

        <section className="workspace">
          <WebContainerPreview files={files} projectId={project.id} />
        </section>
      </div>
    </div>
  );
}

function AgentStep({
  label,
  meta,
  running = false,
}: {
  label: string;
  meta: string;
  running?: boolean;
}) {
  return (
    <div className="agent-step">
      <span className={`status-dot ${running ? "running" : ""}`} />
      <span>{label}</span>
      <span className="step-meta">{meta}</span>
    </div>
  );
}

function PlusText() {
  return <Send aria-hidden="true" className="composer-send-icon" />;
}
