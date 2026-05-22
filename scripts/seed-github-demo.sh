#!/usr/bin/env bash
#
# Seed the repo with demo issues, labels, a milestone, and a release so the
# GitHub plugin (Tasks + Calendar) has live data to show.
#
#   - issues            → Tasks (columns by status label; closed = Done)
#   - milestone due date → Calendar
#   - release            → Calendar
#
# Idempotent-ish: labels/milestone use "create or ignore". Re-running creates
# duplicate issues, so run once. Requires the `gh` CLI, authenticated with
# repo write access.
#
# Usage: REPO=markusahlstrand/canopy bash scripts/seed-github-demo.sh
set -euo pipefail

REPO="${REPO:-markusahlstrand/canopy}"
echo "Seeding $REPO …"

# ── labels the adapter understands ───────────────────────────────────────────
label() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" 2>/dev/null || true; }
label "in progress"   "0e8a16" "Actively being worked on"
label "blocked"       "b60205" "Waiting on something"
label "priority: high" "d93f0b" "High priority"
label "backend"       "1d76db" ""
label "frontend"      "5319e7" ""
label "infra"         "0052cc" ""

# ── milestone with a due date (→ Calendar) ───────────────────────────────────
DUE="$(date -u -v+16d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+16 days' +%Y-%m-%dT%H:%M:%SZ)"
gh api "repos/$REPO/milestones" -f title="Beta launch" -f state="open" -f due_on="$DUE" >/dev/null 2>&1 || true

# ── issues (→ Tasks) ─────────────────────────────────────────────────────────
mk() { gh issue create --repo "$REPO" --title "$1" --body "${2:-}" ${3:+--label "$3"} >/dev/null; echo "  + $1"; }
mk "Wire up billing webhooks"            "Stripe → entitlement sync."        "backend,priority: high"
mk "Audit client bundle size"            "Split heavy chunks; lazy-load."    "frontend"
mk "Draft Q3 roadmap"                    "Themes + sequencing."              ""
mk "Migrate auth to OIDC BFF"            "Encrypted cookie sessions."        "backend,in progress"
mk "Build read-only WebDAV mount"        "Finder mount over app passwords."  "backend,in progress,priority: high"
mk "Enable R2 cross-region replication"  "Blocked on bucket quota."          "infra,blocked"

# A couple closed so the Done column is populated.
N1=$(gh issue create --repo "$REPO" --title "Ship the plugin store" --label "frontend" 2>/dev/null | grep -oE '[0-9]+$' || true)
N2=$(gh issue create --repo "$REPO" --title "Add the command palette" --label "frontend" 2>/dev/null | grep -oE '[0-9]+$' || true)
[ -n "${N1:-}" ] && gh issue close "$N1" --repo "$REPO" >/dev/null 2>&1 || true
[ -n "${N2:-}" ] && gh issue close "$N2" --repo "$REPO" >/dev/null 2>&1 || true

# ── a release (→ Calendar) ───────────────────────────────────────────────────
gh release create "v0.4.0" --repo "$REPO" --title "v0.4.0" --notes "Demo release for the calendar." 2>/dev/null || true

echo "Done. Open Tasks / Calendar in Canopy (GitHub plugin installed) to see live data."
