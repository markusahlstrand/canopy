/**
 * The model-editor (via `usePluginTheme`) reads the host's color scheme from the
 * `.dark` class on the document root. VS Code exposes the theme as a message; map
 * it onto that class so React Flow's colorMode and the shared UI theme follow the
 * editor's light/dark setting.
 */
export function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}
