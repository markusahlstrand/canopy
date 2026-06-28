// Canopy UI-slot plugin — runs inside a sandboxed, opaque-origin iframe.
//
// Contributes two slots, one named export each:
//   export function detailView(ctx)  — the full plugin page
//   export function railPanel(ctx)    — the compact right-rail "Up next"
//
// It asks the host for events via the capability bridge —
// `await ctx.call("calendar.list")` → { events, source, calendars } — and the host
// does the credentialed fetch (or sample fallback). Creating a calendar or event
// goes through the same bridge (`calendar.createCalendar` / `calendar.createEvent`),
// so the plugin never holds credentials and every write is ACL-checked server-side
// (#34). Styling uses the host theme tokens mirrored onto the frame
// (hsl(var(--token))), so it looks native without importing the host's components.
//
// ctx = { container, slot, call(method, params), emit(action, data) }

const TONE = {
  primary: "145 33% 36%",
  info: "212 92% 50%",
  berry: "327 70% 50%",
  accent: "38 92% 50%",
};
const KIND_LABEL = { milestone: "Milestone", release: "Release", issue: "Issue", event: "Event" };

const toneOf = (t) => TONE[t] || TONE.primary;
const fmtDay = (iso) =>
  new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** Tiny element helper: tag, inline cssText, text content. */
function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text != null) node.textContent = text;
  return node;
}

/** Title as a link when the event has a url, else plain text — never innerHTML. */
function title(ev, css) {
  if (ev.url) {
    const a = el("a", css, ev.title);
    a.href = ev.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.style.textDecoration = "none";
    a.style.color = "inherit";
    return a;
  }
  return el("span", css, ev.title);
}

function sourcePill(source) {
  if (source === "github") {
    const p = el(
      "span",
      "display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:500;background:hsl(var(--primary) / 0.1);color:hsl(var(--primary))",
      "Live from GitHub",
    );
    const dot = el("span", "width:6px;height:6px;border-radius:999px;background:hsl(var(--primary))");
    p.prepend(dot);
    return p;
  }
  return el(
    "span",
    "display:inline-flex;align-items:center;border-radius:999px;padding:2px 9px;font-size:11.5px;color:hsl(var(--muted-foreground));background:hsl(var(--accent))",
    "Sample data · install the GitHub plugin for live data",
  );
}

function toneBar(ev, h) {
  return el("span", `width:3px;height:${h}px;flex:none;border-radius:999px;background:hsl(${toneOf(ev.tone)})`);
}

/** Group events by calendar day, chronological. */
function groupByDay(events) {
  const sorted = [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const groups = [];
  for (const e of sorted) {
    const day = fmtDay(e.start);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return groups;
}

/** A small native-looking button. */
function button(label, onClick, opts = {}) {
  const css = opts.primary
    ? "border:none;border-radius:var(--radius);padding:6px 12px;font-size:12.5px;font-weight:500;cursor:pointer;background:hsl(var(--primary));color:hsl(var(--primary-foreground))"
    : "border:1px solid hsl(var(--border));border-radius:var(--radius);padding:6px 12px;font-size:12.5px;font-weight:500;cursor:pointer;background:hsl(var(--card));color:hsl(var(--foreground))";
  const b = el("button", css, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function field(node, label) {
  const wrap = el("label", "display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:hsl(var(--muted-foreground))", label);
  wrap.appendChild(node);
  return wrap;
}

const INPUT_CSS =
  "border:1px solid hsl(var(--border));border-radius:var(--radius);padding:6px 9px;font-size:13px;background:hsl(var(--background));color:hsl(var(--foreground))";

function input(type, placeholder) {
  const i = el("input", INPUT_CSS);
  i.type = type;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

/** A card-styled inline form with the given rows + a submit/cancel footer. */
function formCard(title, rows, onSubmit, onCancel) {
  const card = el(
    "form",
    "display:flex;flex-direction:column;gap:10px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--card));padding:14px",
  );
  card.appendChild(el("div", "font-size:13px;font-weight:600", title));
  for (const r of rows) card.appendChild(r);
  const foot = el("div", "display:flex;gap:8px;justify-content:flex-end");
  const cancel = button("Cancel", onCancel);
  const submit = button("Create", null, { primary: true });
  submit.type = "submit";
  foot.appendChild(cancel);
  foot.appendChild(submit);
  card.appendChild(foot);
  card.addEventListener("submit", (e) => {
    e.preventDefault();
    onSubmit();
  });
  return card;
}

// ── detail view ──────────────────────────────────────────────────────────────
export async function detailView(ctx) {
  const root = el("div", "display:flex;flex-direction:column;gap:14px;max-width:42rem");
  ctx.container.appendChild(root);

  async function reload() {
    root.replaceChildren(el("div", "font-size:12px;color:hsl(var(--muted-foreground))", "Loading…"));
    const [{ events, source }, calendars] = await Promise.all([
      ctx.call("calendar.list"),
      ctx.call("calendar.calendars").catch(() => []),
    ]);
    render(events, source, calendars || []);
  }

  function render(events, source, calendars) {
    root.replaceChildren();

    // Header: source pill + create actions.
    const head = el("div", "display:flex;align-items:center;gap:10px;flex-wrap:wrap");
    head.appendChild(sourcePill(source));
    head.appendChild(el("div", "flex:1"));
    const slot = el("div"); // inline forms render here
    head.appendChild(button("New calendar", () => openCalendarForm()));
    head.appendChild(button("New event", () => openEventForm(calendars), { primary: true }));
    root.appendChild(head);
    root.appendChild(slot);

    function openCalendarForm() {
      const name = input("text", "e.g. Work, Family");
      slot.replaceChildren(
        formCard(
          "New calendar",
          [field(name, "Name")],
          async () => {
            if (!name.value.trim()) return;
            await ctx.call("calendar.createCalendar", { name: name.value.trim() });
            await reload();
          },
          () => slot.replaceChildren(),
        ),
      );
      name.focus();
    }

    function openEventForm(cals) {
      const titleIn = input("text", "Event title");
      const startIn = input("datetime-local", "");
      const sel = el("select", INPUT_CSS);
      // First option = the personal root calendar (no specific folder).
      const root0 = el("option", "", "My calendar");
      root0.value = "";
      sel.appendChild(root0);
      for (const cal of cals) {
        const o = el("option", "", `${cal.name}`);
        o.value = cal.id; // `${spaceId}${path}`
        sel.appendChild(o);
      }
      slot.replaceChildren(
        formCard(
          "New event",
          [field(titleIn, "Title"), field(startIn, "Starts"), field(sel, "Calendar")],
          async () => {
            if (!titleIn.value.trim()) return;
            const cal = cals.find((c) => c.id === sel.value);
            const start = startIn.value ? new Date(startIn.value).toISOString() : undefined;
            await ctx.call("calendar.createEvent", {
              title: titleIn.value.trim(),
              start,
              space: cal ? cal.spaceId : undefined,
              path: cal ? cal.path : undefined,
            });
            await reload();
          },
          () => slot.replaceChildren(),
        ),
      );
      titleIn.focus();
    }

    const groups = groupByDay(events);
    if (groups.length === 0) {
      root.appendChild(
        el(
          "div",
          "border:1px dashed hsl(var(--border));border-radius:var(--radius);padding:32px;text-align:center;font-size:13px;color:hsl(var(--muted-foreground))",
          "Nothing scheduled yet. Create a calendar, then add an event.",
        ),
      );
      return;
    }

    const list = el("div", "display:flex;flex-direction:column;gap:16px");
    for (const g of groups) {
      const row = el("div", "display:flex;gap:16px");
      row.appendChild(
        el("div", "width:7rem;flex:none;padding-top:4px;font-size:12.5px;font-weight:500;color:hsl(var(--muted-foreground))", g.day),
      );
      const items = el("div", "display:flex;flex-direction:column;gap:8px;flex:1");
      for (const ev of g.items) {
        const card = el(
          "div",
          "display:flex;align-items:center;gap:10px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--card));padding:10px",
        );
        // Owned events carry a per-calendar color; provider events fall back to tone.
        card.appendChild(eventBar(ev, 32));
        card.appendChild(title(ev, "flex:1;min-width:0;font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
        if (ev.kind) {
          card.appendChild(
            el(
              "span",
              "border:1px solid hsl(var(--border));border-radius:999px;padding:1px 8px;font-size:10.5px;color:hsl(var(--muted-foreground))",
              KIND_LABEL[ev.kind] || ev.kind,
            ),
          );
        }
        items.appendChild(card);
      }
      row.appendChild(items);
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  await reload();
}

/** Accent bar for an event: a calendar's own color (owned) or its tone (provider). */
function eventBar(ev, h) {
  const color = ev.color || toneOf(ev.tone);
  return el("span", `width:3px;height:${h}px;flex:none;border-radius:999px;background:hsl(${color})`);
}

// ── rail panel ───────────────────────────────────────────────────────────────
export async function railPanel(ctx) {
  const root = el("div", "display:flex;flex-direction:column;gap:12px");
  ctx.container.appendChild(root);
  root.appendChild(el("div", "font-weight:600", "Up next"));

  const { events } = await ctx.call("calendar.list");
  const now = Date.now();
  const upcoming = events
    .filter((e) => Date.parse(e.start) >= now - 864e5)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 6);

  if (upcoming.length === 0) {
    root.appendChild(el("p", "font-size:12.5px;color:hsl(var(--muted-foreground))", "Nothing coming up."));
    return;
  }

  const list = el("div", "display:flex;flex-direction:column;gap:6px");
  for (const ev of upcoming) {
    const item = el("div", "display:flex;gap:10px;border-radius:var(--radius);padding:6px");
    item.appendChild(toneBar(ev, 30));
    const body = el("div", "min-width:0;flex:1");
    body.appendChild(title(ev, "display:block;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"));
    body.appendChild(
      el("div", "font-size:11.5px;color:hsl(var(--muted-foreground));font-family:ui-monospace,SFMono-Regular,Menlo,monospace", fmtDay(ev.start)),
    );
    item.appendChild(body);
    list.appendChild(item);
  }
  root.appendChild(list);
}
