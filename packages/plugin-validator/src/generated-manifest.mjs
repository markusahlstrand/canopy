/** Extra manifest constraints for the legacy generated-plugin endpoint. No Node APIs or schema compilation. */
const SANDBOX_VIEWER_CAPS = new Set(["item:read", "item:write", "net:fetch"]);

export function validateGeneratedManifest(m) {
  if (!m || typeof m !== "object") return "manifest must be an object";
  const man = m;
  if (typeof man.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(man.id))
    return "manifest.id must be kebab-case (2–49 chars)";
  if (typeof man.name !== "string" || !man.name.trim()) return "manifest.name is required";
  if (!Array.isArray(man.capabilities)) return "manifest.capabilities must be an array";
  for (const cap of man.capabilities) {
    if (!cap || typeof cap !== "object" || !SANDBOX_VIEWER_CAPS.has(cap.kind ?? ""))
      return `capability "${cap?.kind}" is not allowed for a generated plugin`;
    if (cap.kind === "net:fetch" && (!Array.isArray(cap.hosts) || cap.hosts.length === 0))
      return "net:fetch requires a non-empty hosts list";
  }
  const contributes = man.contributes;
  const viewers = contributes?.viewers;
  const detailView = contributes?.detailView;
  const hasViewers = Array.isArray(viewers) && viewers.length > 0;
  const hasApp = !!detailView && typeof detailView === "object";
  if (!hasViewers && !hasApp)
    return "manifest must contribute at least one viewer or a detailView (app)";
  for (const v of (hasViewers ? viewers : [])) {
    if (!Array.isArray(v.match) || v.match.length === 0) return "each viewer needs a non-empty match list";
  }
  if (hasApp) {
    const dv = detailView;
    if (typeof dv.id !== "string" || !dv.id.trim()) return "detailView needs an id";
    if (typeof dv.title !== "string" || !dv.title.trim()) return "detailView needs a title";
  }
  return null;
}
