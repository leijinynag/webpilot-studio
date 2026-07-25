import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  Send,
  Square,
} from "lucide-react";

import { PreviewSite } from "@/components/demo/preview-site";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function WorkbenchPage() {
  return (
    <div className="workbench-page page-in">
      <div className="workbench-top">
        <div className="project-crumb">
          <span>Projects</span>
          <span>/</span>
          <b>Atlas Finance</b>
          <span>Saved just now</span>
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
            <Link href="/p/atlas-finance/source-control">
              Changes <Badge variant="outline">3</Badge>
            </Link>
          </ToggleGroupItem>
          <ToggleGroupItem value="tests">Tests</ToggleGroupItem>
        </ToggleGroup>
        <div className="workbench-actions">
          <Button asChild size="sm" variant="outline">
            <Link href="/p/atlas-finance/source-control">Source Control</Link>
          </Button>
          <Button size="sm" variant="ghost">
            Export
          </Button>
          <Button asChild className="app-button-accent" size="sm">
            <Link href="/p/atlas-finance/publish">
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
          <div className="workspace-toolbar">
            <div className="preview-tools">
              <ToolbarButton label="后退">
                <ArrowLeft />
              </ToolbarButton>
              <ToolbarButton label="前进">
                <ArrowRight />
              </ToolbarButton>
              <ToolbarButton label="刷新预览">
                <RefreshCw />
              </ToolbarButton>
            </div>
            <div className="url-bar">
              <span className="url-status" />
              localhost:5173 / overview
            </div>
            <div className="preview-tools">
              <ToolbarButton label="适配视口">
                <Square />
              </ToolbarButton>
              <ToolbarButton label="打开预览">
                <ExternalLink />
              </ToolbarButton>
              <ToolbarButton label="更多预览操作">
                <MoreHorizontal />
              </ToolbarButton>
            </div>
          </div>
          <div className="preview-stage">
            <PreviewSite />
          </div>
          <div className="evidence-drawer">
            <div className="evidence-col">
              <b>Console</b>
              <div className="console-line ok">✓ dev server ready in 612ms</div>
              <div className="console-line">! chart warning captured</div>
            </div>
            <div className="evidence-col">
              <b>Network</b>
              <span className="network-pill">GET /api/metrics 200</span>
              <span className="network-pill">7 requests</span>
              <span className="network-pill">0 failed</span>
            </div>
            <div className="evidence-col">
              <b>Smoke flow</b>
              <div className="test-line">
                <span>Open overview</span>
                <b>Passed</b>
              </div>
              <div className="test-line">
                <span>Change period</span>
                <b>Running</b>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} size="icon-sm" variant="ghost">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
