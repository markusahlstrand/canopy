import { Button } from "@/components/ui/button";
import { cn, Icon } from "@canopy/ui";
import { loginUrl } from "@/lib/api";

/**
 * Welcome / marketing landing — the signed-out experience. A purely personal,
 * end-user pitch (no "business"/"CRM" language; the platform stays horizontal
 * underneath). Copy and structure track the canonical positioning in the repo's
 * POSITIONING.md: the arc is no islands → it falls into place → your assistant
 * gets you → no walls, with the "operating system for your data and your life"
 * reveal landing last. Rendered immersive (edge-to-edge, no plugin header) via the
 * manifest's detailView.immersive flag.
 */

// Start sign-in like the host does (App.signIn), but return to the app root rather
// than back here — `?view=plugin:welcome` isn't installed for signed-in users, so
// returning to it would land them on a blank view. Dropping the query sends them to
// their drive instead.
function startSignIn() {
  window.location.href = loginUrl(window.location.pathname);
}

/** The built-in apps, named (concreteness is the warmth — see POSITIONING.md). */
const APPS: { icon: string; label: string }[] = [
  { icon: "my-drive", label: "Files" },
  { icon: "calendar", label: "Calendar" },
  { icon: "check-square", label: "Tasks" },
  { icon: "file-text", label: "Notes" },
  { icon: "sparkles", label: "Assistant" },
];

/** The four corollaries of the thesis, in arc order. */
const PILLARS: { icon: string; title: string; body: string }[] = [
  {
    icon: "grid",
    title: "No more islands",
    body: "AI makes it easy to spin up a clever one-off app — and end up with a drawer of things that don't talk to each other. Canopy puts everything on shared ground, so it's one system, not a pile of silos.",
  },
  {
    icon: "plugin",
    title: "It falls into place",
    body: "Because it all shares one data layer, your apps fit together by default. Add one thing and ten things just work — integrations you never planned for, simply there.",
  },
  {
    icon: "sparkles",
    title: "Your assistant gets you",
    body: "The assistant reads the same shared model everything else does, so it has the right context for whatever you're doing — your calendar, your files, your numbers — with nothing to set up.",
  },
  {
    icon: "package",
    title: "No walls",
    body: "You'll probably just use what's here. But nothing's ever locked: if you need something new, it can exist in minutes — and what you build, you can share.",
  },
];

/** Concrete, personal examples of the headroom — never business/CRM (see POSITIONING.md). */
const EXAMPLES: { icon: string; label: string }[] = [
  { icon: "timer", label: "Workout log" },
  { icon: "bookmark", label: "Reading list" },
  { icon: "wallet", label: "Budget tracker" },
  { icon: "gamepad-2", label: "A little game" },
];

function IconTile({ name, className }: { name: string; className?: string }) {
  return (
    <div className={cn("grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary", className)}>
      <Icon name={name} size={22} />
    </div>
  );
}

export function WelcomeView() {
  return (
    <div className="min-h-full bg-background">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-border/60">
        {/* soft Canopy-green wash behind the hero */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/[0.07] to-transparent"
        />
        <div className="relative mx-auto max-w-[820px] px-6 py-20 text-center sm:py-28">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3 py-1 text-[12px] font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            Your stuff · your home · your assistant
          </div>

          <h1 className="text-balance text-[44px] font-semibold leading-[1.05] tracking-tight sm:text-[56px]">
            Stop building islands.
          </h1>

          <p className="mx-auto mt-6 max-w-[640px] text-balance text-[18px] font-medium leading-relaxed text-foreground/90">
            Canopy is one place for your files, calendar, tasks, and notes — kept in storage you own, with an
            assistant that can see across all of it.
          </p>

          <p className="mx-auto mt-4 max-w-[600px] text-[15px] leading-relaxed text-muted-foreground">
            Open it in your browser and it feels familiar: a drive, a calendar, a to-do list. What's different is
            underneath — it's all one connected system. Ask{" "}
            <span className="font-medium text-foreground">"what did the Berlin trip cost?"</span> and your assistant
            pulls the dates from your calendar and the receipts from your files, together, without you setting
            anything up.
          </p>

          {/* the apps, named */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
            {APPS.map((a) => (
              <span
                key={a.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-3 py-1.5 text-[13px] font-medium text-foreground/80"
              >
                <Icon name={a.icon} size={14} className="text-primary" />
                {a.label}
              </span>
            ))}
          </div>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" className="gap-1.5 px-6" onClick={startSignIn}>
              Get started
              <Icon name="chevron-right" size={16} />
            </Button>
            <Button asChild size="lg" variant="outline" className="px-6">
              <a href="?view=plugin:documentation">Explore the docs</a>
            </Button>
          </div>

          <p className="mt-7 text-[13px] italic text-muted-foreground">
            What if ChatGPT and Google Drive had a child — one you could build apps on?
          </p>
        </div>
      </section>

      {/* ── The four corollaries ─────────────────────────────────────────── */}
      <section className="mx-auto max-w-[940px] px-6 py-16 sm:py-20">
        <div className="grid gap-5 sm:grid-cols-2">
          {PILLARS.map((p) => (
            <div
              key={p.title}
              className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-6 transition-colors hover:border-primary/40"
            >
              <IconTile name={p.icon} />
              <div>
                <h2 className="text-[18px] font-semibold tracking-tight">{p.title}</h2>
                <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted-foreground">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        {/* headroom made concrete */}
        <div className="mt-5 rounded-2xl border border-dashed border-border/70 bg-muted/30 p-6">
          <p className="text-[14px] font-medium text-foreground/80">
            Build it in minutes, or install one someone else made — and it works with everything from day one:
          </p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {EXAMPLES.map((e) => (
              <span
                key={e.label}
                className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-[13.5px] font-medium text-foreground/80"
              >
                <Icon name={e.icon} size={15} className="text-primary" />
                {e.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── The reveal + closing CTA ─────────────────────────────────────── */}
      <section className="border-t border-border/60 bg-primary/[0.04]">
        <div className="mx-auto max-w-[720px] px-6 py-20 text-center">
          <h2 className="text-balance text-[30px] font-semibold leading-tight tracking-tight sm:text-[36px]">
            An operating system for your data and your life.
          </h2>
          <p className="mx-auto mt-4 max-w-[560px] text-[16px] leading-relaxed text-muted-foreground">
            One place where your files live, your apps fit together, and your assistant always knows where everything
            is. Yours to keep, yours to shape.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" className="gap-1.5 px-6" onClick={startSignIn}>
              Get started
              <Icon name="chevron-right" size={16} />
            </Button>
            <Button asChild size="lg" variant="outline" className="px-6">
              <a href="?view=plugin:documentation">See how it works</a>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
