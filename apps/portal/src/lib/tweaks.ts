export interface Tweaks {
  theme: "light" | "dark";
  accent: string;
  radius: "square" | "default" | "round";
  density: "compact" | "default" | "comfy";
  font: "geist" | "inter" | "system";
  sidebarCollapsed: boolean;
  showRail: boolean;
}

export const DEFAULT_TWEAKS: Tweaks = {
  theme: "light",
  accent: "green",
  radius: "default",
  density: "default",
  font: "geist",
  sidebarCollapsed: false,
  showRail: false,
};

export const ACCENT_HSL: Record<string, string> = {
  green: "145 33% 36%",
  blue: "212 92% 45%",
  violet: "262 60% 55%",
  orange: "20 85% 52%",
  rose: "346 70% 50%",
  zinc: "240 6% 25%",
};

export const ACCENT_HSL_DARK: Record<string, string> = {
  green: "145 38% 52%",
  blue: "212 92% 60%",
  violet: "262 70% 70%",
  orange: "20 90% 60%",
  rose: "346 80% 62%",
  zinc: "0 0% 92%",
};

export const FONT_STACK: Record<string, string> = {
  geist: "'Geist', 'Inter', ui-sans-serif, system-ui, sans-serif",
  inter: "'Inter', 'Geist', ui-sans-serif, system-ui, sans-serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};
