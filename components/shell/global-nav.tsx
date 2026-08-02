"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

const primaryLinks = [
  { href: "/", label: "Projects" },
  { href: "/showcase", label: "Showcase" },
] as const;

export function GlobalNav() {
  const pathname = usePathname();
  const { locale, setLocale, t } = useUiI18n();
  const [mobileMenuPath, setMobileMenuPath] = React.useState<string | null>(
    null,
  );
  // 由当前路径推导菜单展开态，路由切换后旧菜单不会继续覆盖新页面。
  const isMobileMenuOpen = mobileMenuPath === pathname;

  return (
    <nav className="global-nav" aria-label={t("nav.aria.main")}>
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
            {t(`nav.primary.${link.href === "/" ? "projects" : "showcase"}`)}
          </Link>
        ))}
        <span className="muted" aria-disabled="true">
          {t("nav.primary.docs")}
        </span>
      </div>

      <div className="nav-tools">
        <Button
          aria-label={t("nav.aria.language")}
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          size="icon"
          variant="ghost"
        >
          {t(`nav.language.${locale}`)}
        </Button>
        <ThemeToggle />
        <span className="guest-workspace">
          <span className="guest-avatar">G</span>
          <span>{t("nav.workspace")}</span>
        </span>
        <Button
          aria-expanded={isMobileMenuOpen}
          aria-label={t(
            isMobileMenuOpen ? "nav.aria.closeMenu" : "nav.aria.openMenu",
          )}
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
              {t(`nav.primary.${link.href === "/" ? "projects" : "showcase"}`)}
            </Link>
          ))}
          <span className="muted">{t("nav.primary.docs")}</span>
        </div>
      ) : null}
    </nav>
  );
}
