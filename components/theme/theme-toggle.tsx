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

const themeOptions: Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "system", label: "跟随系统", icon: Laptop },
  { value: "light", label: "浅色主题", icon: Sun },
  { value: "dark", label: "暗色主题", icon: Moon },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const currentOption =
    themeOptions.find((option) => option.value === preference) ??
    themeOptions[0];
  const CurrentIcon = currentOption.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="切换主题"
          className="theme-toggle"
          size="sm"
          variant="outline"
        >
          <CurrentIcon />
          <span className="theme-toggle-label">{currentOption.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuLabel>外观</DropdownMenuLabel>
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
