/**
 * Display-mode / platform helpers. Note: these are for the app's own behavior and
 * diagnostics only — never transmit them to a server.
 *
 * "Pinned to home screen" is a *display mode*, not a device type:
 *   - the standard `(display-mode: standalone)` media query (Chromium, Android,
 *     desktop installed PWAs), OR
 *   - iOS Safari's legacy non-standard `navigator.standalone` flag.
 *
 * Device type from `navigator.userAgentData` is Chromium-only (undefined on iOS
 * Safari and Firefox), so it is NOT a reliable basis for the responsive layout
 * switch — use viewport width (see useIsMobile) for that.
 */

interface UaData {
  mobile?: boolean;
  platform?: string;
}

/** True when launched from the home screen / installed (standalone/fullscreen/minimal-ui). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const mm = (q: string) => window.matchMedia(q).matches;
  return iosStandalone || mm("(display-mode: standalone)") || mm("(display-mode: fullscreen)") || mm("(display-mode: minimal-ui)");
}

/** Best-effort platform snapshot. `mobile` is null where the browser can't say (iOS Safari, Firefox). */
export function platformInfo(): { standalone: boolean; mobile: boolean | null; platform: string } {
  const uaData = (navigator as unknown as { userAgentData?: UaData }).userAgentData;
  return {
    standalone: isStandalone(),
    mobile: uaData?.mobile ?? null,
    platform: uaData?.platform ?? "",
  };
}
