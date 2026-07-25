import Link from "next/link";
import { Check, ExternalLink, Smartphone } from "lucide-react";

import { PreviewSite } from "@/components/demo/preview-site";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function PublishPage() {
  return (
    <div className="publish-page page-in">
      <section className="publish-preview">
        <div className="publish-preview-head">
          <b>Publish preview</b>
          <ToggleGroup
            aria-label="预览设备"
            className="device-switch"
            defaultValue="desktop"
            type="single"
          >
            <ToggleGroupItem aria-label="桌面预览" value="desktop">
              <span className="desktop-device-icon" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="移动端预览" value="mobile">
              <Smartphone />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="publish-canvas">
          <PreviewSite />
        </div>
        <div className="build-status">
          <BuildStep label="Production build" />
          <BuildStep label="Assets collected" />
          <BuildStep label="4 smoke checks" />
        </div>
      </section>

      <section className="publish-settings">
        <div className="eyebrow">Showcase / Publish</div>
        <h1 className="font-editorial publish-title">
          Ready for
          <br />
          the outside world.
        </h1>
        <p>
          发布的是经过生产构建的静态产物，不会在服务端执行项目源码。发布后可以随时撤销或更新。
        </p>

        <div className="publish-form-grid">
          <div className="wide">
            <label className="field-label" htmlFor="publish-title">
              Title
            </label>
            <input
              className="field"
              defaultValue="Atlas Finance"
              id="publish-title"
            />
          </div>
          <div className="wide">
            <label className="field-label" htmlFor="publish-description">
              Description
            </label>
            <textarea
              className="field"
              defaultValue="A calm financial dashboard for independent creative studios."
              id="publish-description"
            />
          </div>
          <div className="wide">
            <label className="field-label" htmlFor="public-url">
              Public URL
            </label>
            <div className="slug-field">
              <span className="slug-prefix">webpilot.studio/showcase/</span>
              <input
                className="field"
                defaultValue="atlas-finance"
                id="public-url"
              />
            </div>
          </div>
          <div className="wide">
            <span className="field-label">Cover</span>
            <div className="cover-picker">
              <div className="cover-thumb" />
              <div className="cover-copy">
                <b>Current preview capture</b>
                <span>
                  1440 × 900 · Captured after the latest successful browser run.
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="publish-checks">
          <CheckRow label="Production build completed" value="Passed" />
          <CheckRow label="Broken asset scan" value="Passed" />
          <CheckRow label="Primary interaction flow" value="4 / 4" />
          <CheckRow label="Console errors" value="0" />
        </div>
        <div className="publish-actions">
          <span>Last checkpoint · Run 04</span>
          <Button className="app-button-accent" size="sm">
            Publish showcase
            <ExternalLink data-icon="inline-end" />
          </Button>
        </div>
        <Link className="back-to-workbench" href="/p/atlas-finance">
          返回 Agent 工作台
        </Link>
      </section>
    </div>
  );
}

function BuildStep({ label }: { label: string }) {
  return (
    <div className="build-step">
      <span className="build-check">
        <Check />
      </span>
      <span>{label}</span>
    </div>
  );
}

function CheckRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="check-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
