import Link from "next/link";
import { Check, GitBranch, RefreshCw, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { demoFiles } from "@/domains/project/demo-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const diffLines = [
  ["31", "31", "export function Dashboard() {", "normal"],
  ["32", "32", "  return (", "normal"],
  ["33", "", '-   <main className="dashboard-grid">', "del"],
  ["34", "", "-     <SummaryPanel metrics={metrics} />", "del"],
  ["", "33", '+   <main className="overview">', "add"],
  ["", "34", "+     <OverviewHeader", "add"],
  ["", "35", '+       eyebrow="Financial clarity / 2026"', "add"],
  ["", "36", '+       title="One view of what matters."', "add"],
  ["", "37", "+     />", "add"],
  ["35", "38", '      <section className="metric-grid">', "normal"],
  ["", "39", "+       <RevenueCard", "add"],
  ["", "40", '+         value="$84.2k"', "add"],
  ["", "41", '+         delta="+18.4%"', "add"],
  ["", "42", "+       />", "add"],
  ["36", "43", "        {metrics.map((metric) => (", "normal"],
  [
    "37",
    "44",
    "          <MetricCard key={metric.id} {...metric} />",
    "normal",
  ],
  ["38", "45", "        ))}", "normal"],
  ["39", "46", "      </section>", "normal"],
  ["40", "47", "    </main>", "normal"],
] as const;

export function SourceControlPage() {
  const groupedFiles = ["Staged changes", "Changes", "Untracked"].map(
    (group) => ({
      group,
      files: demoFiles.filter((file) => file.group === group),
    }),
  );

  return (
    <div className="source-page page-in">
      <aside className="source-sidebar">
        <div className="source-heading">
          <b>Source Control</b>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button aria-label="刷新变更" size="icon-sm" variant="ghost">
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新变更</TooltipContent>
          </Tooltip>
        </div>
        <label className="sr-only" htmlFor="branch">
          当前分支
        </label>
        <select className="select-control" defaultValue="main" id="branch">
          <option value="main">main</option>
          <option value="experiment">experiment</option>
        </select>
        <div className="file-groups">
          {groupedFiles.map(({ group, files }) => (
            <div key={group}>
              <div className="change-group-title">
                <span>{group}</span>
                <Badge variant="outline">{files.length}</Badge>
              </div>
              {files.map((file) => (
                <div
                  className={`file-change ${
                    "active" in file && file.active ? "active" : ""
                  }`}
                  key={file.name}
                >
                  {"staged" in file ? (
                    <Check />
                  ) : (
                    <span className="empty-check" />
                  )}
                  <span>{file.name}</span>
                  <span className="file-status">{file.status}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="source-diff">
        <div className="diff-header">
          <b>src/Dashboard.tsx</b>
          <div className="diff-actions">
            <Button className="diff-mode-button" size="xs" variant="ghost">
              Inline
            </Button>
            <Button className="diff-mode-button" size="xs" variant="ghost">
              Ignore whitespace
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="更多差异操作"
                  size="icon-xs"
                  variant="ghost"
                >
                  <MoreHorizontal />
                </Button>
              </TooltipTrigger>
              <TooltipContent>更多差异操作</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="code-diff">
          {diffLines.map(([oldLine, newLine, code, kind], index) => (
            <div className={`code-line ${kind}`} key={`${code}-${index}`}>
              <span className="ln old">{oldLine}</span>
              <span className="ln">{newLine}</span>
              <span>{formatDiffCode(code)}</span>
            </div>
          ))}
        </div>
      </section>

      <aside className="source-commit">
        <h2 className="font-editorial">Commit changes</h2>
        <p>
          只提交你已经检查过的内容。Agent 不会在没有明确指令时自动创建 commit。
        </p>
        <label className="field-label" htmlFor="commit-message">
          Message
        </label>
        <textarea
          className="field"
          defaultValue="Refine dashboard hierarchy and add revenue comparison"
          id="commit-message"
        />
        <div className="commit-summary">
          <div className="summary-cell">
            <b>4</b>
            <span>files</span>
          </div>
          <div className="summary-cell">
            <b>+126</b>
            <span>added</span>
          </div>
          <div className="summary-cell">
            <b>−48</b>
            <span>removed</span>
          </div>
        </div>
        <div className="author-row">
          <div>
            <label className="field-label" htmlFor="author">
              Author
            </label>
            <input className="field" defaultValue="Guest Builder" id="author" />
          </div>
          <div>
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input className="field" defaultValue="guest@local" id="email" />
          </div>
        </div>
        <Button className="commit-button app-button-accent" size="sm">
          <GitBranch data-icon="inline-start" />
          Commit staged changes
        </Button>
        <div className="history">
          <h3>History</h3>
          <div className="commit-item">
            <span className="commit-node" />
            <div>
              <b>Initial dashboard structure</b>
              <span>7aa1fd2 · 18 min ago</span>
            </div>
          </div>
          <div className="commit-item">
            <span className="commit-node" />
            <div>
              <b>Configure project starter</b>
              <span>b107e8a · 22 min ago</span>
            </div>
          </div>
        </div>
        <Link className="back-to-workbench" href="/p/atlas-finance">
          返回 Agent 工作台
        </Link>
      </aside>
    </div>
  );
}

function formatDiffCode(code: string): ReactNode {
  // 先拆分语法片段，再交给 React 渲染，避免手动拼接 HTML 造成 hydration 不一致。
  const tokens = code.split(/("[^"]*"|\b(?:export|function|return)\b)/g);

  return tokens.map((token, index) => {
    if (/^"[^"]*"$/.test(token)) {
      return (
        <span className="str" key={`${token}-${index}`}>
          {token}
        </span>
      );
    }

    if (/^(export|function|return)$/.test(token)) {
      return (
        <span className="kw" key={`${token}-${index}`}>
          {token}
        </span>
      );
    }

    return <span key={`${token}-${index}`}>{token}</span>;
  });
}
