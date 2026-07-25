"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const primaryLinks = [
  { href: "/", label: "Projects" },
  { href: "/showcase", label: "Showcase" },
] as const;

export function GlobalNav() {
  const pathname = usePathname();
  const [mobileMenuPath, setMobileMenuPath] = React.useState<string | null>(
    null,
  );
  // 由当前路径推导菜单展开态，路由切换后旧菜单不会继续覆盖新页面。
  const isMobileMenuOpen = mobileMenuPath === pathname;

  return (
    <nav className="global-nav" aria-label="主导航">
      <Link className="brand-lockup" href="/">
        <span aria-hidden="true" className="brand-mark" />
        <span>WebPilot Studio</span>
      </Link>

      <div className="global-links">
        {primaryLinks.map((link) => (
          <Link
            key={link.href}
            aria-current={
              pathname === link.href ||
              (link.href === "/" && pathname.startsWith("/p/"))
                ? "page"
                : undefined
            }
            href={link.href}
          >
            {link.label}
          </Link>
        ))}
        <span className="muted" aria-disabled="true">
          Docs
        </span>
      </div>

      <div className="nav-tools">
        <Button aria-label="切换语言" size="icon" variant="ghost">
          中
        </Button>
        <ThemeToggle />
        <span className="guest-workspace">
          <span className="guest-avatar">G</span>
          <span>Guest workspace</span>
        </span>
        <Button
          aria-expanded={isMobileMenuOpen}
          aria-label={isMobileMenuOpen ? "关闭导航菜单" : "打开导航菜单"}
          className="mobile-menu-trigger"
          onClick={() => setMobileMenuPath(isMobileMenuOpen ? null : pathname)}
          size="icon"
          variant="outline"
        >
          {isMobileMenuOpen ? <X /> : <Menu />}
        </Button>
      </div>

      {isMobileMenuOpen ? (
        <div className="mobile-menu">
          {primaryLinks.map((link) => (
            <Link
              key={link.href}
              aria-current={pathname === link.href ? "page" : undefined}
              className={cn(pathname === link.href && "active")}
              href={link.href}
            >
              {link.label}
            </Link>
          ))}
          <span className="muted">Docs</span>
        </div>
      ) : null}
    </nav>
  );
}
