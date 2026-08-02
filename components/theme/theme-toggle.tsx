"use client";

import { Laptop, Moon, Sun } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useTheme,
  type ThemePreference,
} from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { useUiI18n } from "@/infrastructure/i18n/ui";

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const { t } = useUiI18n();
  const themeOptions: Array<{
    value: ThemePreference;
    label: string;
    icon: typeof Sun;
  }> = [
    { value: "system", label: t("theme.system"), icon: Laptop },
    { value: "light", label: t("theme.light"), icon: Sun },
    { value: "dark", label: t("theme.dark"), icon: Moon },
  ];
  const currentOption =
    themeOptions.find((option) => option.value === preference) ??
    themeOptions[0];
  const CurrentIcon = currentOption.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("theme.toggle")}
          className="theme-toggle"
          size="sm"
          variant="outline"
        >
          <CurrentIcon />
          <span className="theme-toggle-label">{currentOption.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuLabel>{t("theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
        >
          {themeOptions.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
