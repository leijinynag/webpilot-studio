import Link from "next/link";
import { ArrowUpRight, Plus, Send } from "lucide-react";

import { demoActivity, demoProjects } from "@/domains/project/demo-data";
import { Button } from "@/components/ui/button";

export function ProjectsPage() {
  return (
    <div className="projects-page page-in">
      <section className="projects-main">
        <div className="projects-hero">
          <div>
            <div className="eyebrow">Your workspace</div>
            <h1 className="font-editorial projects-title">
              Make something
              <br />
              worth keeping.
            </h1>
            <p className="projects-lede">
              从一个想法开始，WebPilot
              会修改代码、运行项目、验证交互，并留下每一次变化的证据。
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/new">
              <Plus data-icon="inline-start" />
              New project
            </Link>
          </Button>
        </div>

        <div className="start-composer panel">
          <textarea
            aria-label="描述你想构建的项目"
            className="composer-input"
            defaultValue="Describe what you want to build…"
          />
          <div className="composer-actions">
            <div className="composer-left">
              <Button size="sm" variant="outline">
                <Plus data-icon="inline-start" />
                Image
              </Button>
              <Button size="sm" variant="outline">
                React + TypeScript
              </Button>
            </div>
            <Button asChild className="app-button-accent" size="sm">
              <Link href="/new">
                Start building
                <Send data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="section-heading">
          <h2>Recent projects</h2>
          <span>3 projects · Updated today</span>
        </div>
        <div className="project-list">
          {demoProjects.map((project) => {
            const isActive = project.id === "atlas-finance";
            const projectContent = (
              <>
                <span className={`project-thumb ${project.thumb}`} />
                <span className="project-name">
                  <b>{project.name}</b>
                  <span>{project.description}</span>
                </span>
                <span className="storage-badge">{project.repository}</span>
                <span className="project-meta">{project.updatedAt}</span>
                <ArrowUpRight className="project-arrow" />
              </>
            );

            return isActive ? (
              <Link
                key={project.id}
                className="project-row"
                href={`/p/${project.id}`}
              >
                {projectContent}
              </Link>
            ) : (
              <div key={project.id} className="project-row is-static">
                {projectContent}
              </div>
            );
          })}
        </div>
      </section>

      <aside className="projects-aside">
        <div className="eyebrow">Live activity</div>
        <h2 className="font-editorial aside-title">Runs in motion</h2>
        <div className="run-timeline">
          {demoActivity.map((activity) => (
            <div className="timeline-item" key={activity.title}>
              <span className={`status-dot ${activity.status}`} />
              <div className="timeline-body">
                <b>{activity.title}</b>
                <span>{activity.detail}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="quota">
          <div className="quota-row">
            <span>Today&apos;s Agent budget</span>
            <b>38 / 100</b>
          </div>
          <div className="quota-bar">
            <i />
          </div>
        </div>
      </aside>
    </div>
  );
}
