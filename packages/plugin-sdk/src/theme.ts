import { useEffect, useState } from "react";

/**
 * The host's current color scheme, tracked live. Mirrors the app's `.dark` class on
 * the document root so a plugin can theme itself (e.g. drive React Flow's colorMode)
 * without each plugin re-implementing the observer.
 */
export function usePluginTheme(): { dark: boolean } {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return { dark };
}
