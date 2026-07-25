import { GlobalNav } from "@/components/shell/global-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <div className="app-frame">
        <div className="app-browser">
          <div aria-hidden="true" className="browser-chrome">
            <div className="traffic-lights">
              <span />
              <span />
              <span />
            </div>
            <div className="browser-address">webpilot.studio</div>
            <span />
          </div>
          <GlobalNav />
          <main className="app-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
