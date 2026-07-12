# Canopy — Positioning

> Internal reference for end-user marketing copy (the `welcome` plugin), the docs
> intro, and any future messaging. Not a rendered docs page.

## North star (the thesis)

**Canopy is an operating system for your data and your life** — one place where your
files live, your apps fit together, and your assistant always knows where everything
is.

It earns the "operating system" claim literally, not as a metaphor:

| OS concept | Canopy |
|---|---|
| Kernel / shell | the slim core |
| Filesystem | bring-your-own storage + the shared information model |
| Apps | plugins |
| System services every app gets free | the assistant, the data model, identity/auth |
| Install / share apps | plugin sharing between users |
| Programs that compose (Unix pipes) | apps that interoperate through the shared model |

> Most tools *call* themselves an operating system. Canopy actually has a kernel, a
> filesystem, and apps. Say it out loud — it's a real differentiator.

## The four corollaries (everything reduces to the thesis)

1. **No islands.** AI makes it trivial to spin up one-off apps, but they're islands —
   their own data, disconnected from everything else. An OS is what turns apps into a
   system. *(Files, calendar, tasks, notes — together, on shared ground.)*
2. **It falls into place.** A shared filesystem means apps compose by default. Add one
   thing and ten things just work — integrations you didn't plan for, just *there*.
3. **Your assistant gets you.** The assistant is a system service reading one shared
   model, so it has the right context for anything — taxes, vacation planning, your
   training stats — with no per-app integration. *Every plugin you add doesn't just
   work with your other apps; it teaches your assistant something new.*
4. **No walls.** If you ever need more, it can exist in minutes — and what you build,
   you can share. Extensibility is **headroom**, not homework: most people just use
   what's there, but nothing is ever locked.

## Target market

The **platform is horizontal** — with the right plugins Canopy is equally a CRM, an ops
tool, a team workspace. But the **landing page leads purely personal** (decided
2026-06-28): warm, emotional, individual. No "business" or "CRM" language in the
end-user copy. Rationale: personal is the authentic origin and the differentiator
(SharePoint/Salesforce own "cold + corporate"; nobody owns "warm + personal + grows with
you"), and personal→team is the proven land-and-expand path (Notion, Slack, Figma).
Business capability stays implicit headroom, not a pitch. The "no walls" pillar uses
personal examples only (workout log, reading list, budget, a game) — never CRM.

## Positioning vs. the field

|  | Fixed apps | Build-your-own apps |
|---|---|---|
| **Islands (siloed data)** | Google Workspace | v0 / Artifacts / Lovable / GPT apps |
| **Shared data substrate** | micro.so | **Canopy** ← the empty corner |

micro.so consolidated a *fixed* set of apps onto one substrate. The AI app-builders give
*infinite* apps with *zero* shared data. Canopy is the only one claiming both: infinite
apps, one substrate — and shareable.

### The "build apps that integrate" precedents — who owns which corner

| Who | Build real apps? | Apps share one data layer? | AI-native? | You own the data? | Personal? |
|---|---|---|---|---|---|
| Notion / Airtable | only inside their primitives | ✓ (locked to their model) | bolted on | ✗ | ✓ |
| Salesforce / ServiceNow | ✓ | ✓ | partial | ✗ | ✗ |
| SharePoint + Graph + Copilot | ✓ | ✓ | bolted on | ✗ | ✗ |
| GPTs / Claude apps / v0 | ✓ | ✗ (islands) | ✓ | ✗ | ✓ |
| Obsidian | ✓ (plugins) | ✓ (local notes) | ✗ | ✓ | ✓ |
| **Canopy** | ✓ | ✓ | ✓ | ✓ | ✓ |

**SharePoint is the strongest precedent.** It handles all kinds of content (docs, lists,
pages, media + metadata), sites ≈ spaces, lists ≈ the information model, web parts /
Power Apps ≈ plugins — and it's the substrate *under the whole M365 suite* (Teams,
OneDrive sit on it). Crucially, **Copilot works because of Microsoft Graph** — one
unified model across all that content. So Microsoft already validated the entire thesis
(shared substrate + assistant on top) — for enterprises. The pitch is therefore not
"untested idea" but **proven model, new market**: Canopy is that, rebuilt personal,
AI-native from the ground up, ownable, and consumer-simple.

> **Defensible one-liner (investor/dev):** "What SharePoint + Copilot proved at
> enterprise scale — rebuilt personal, AI-native, and ownable." / "Salesforce's
> app-platform idea, for your own life."
>
> **Caveat:** never say "SharePoint" to end users — the word carries corporate-pain
> baggage. End-user framing stays warm: "ChatGPT and Google Drive had a child you can
> build apps on."

### What we steal from micro.so
- **Concreteness is the warmth.** Name the apps (files, calendar, tasks, notes), don't
  say "unified workspace." Specificity reads as confidence.
- **"and AI" as the tie that binds, not the buzzword up front.**
- **Restraint** — one headline, little body copy, a little design personality.

## Voice

Warm + confident, not hypey. No superlatives we can't back up. Lead with the concrete
*what*; let the "operating system" frame land last, as the name for something the reader
has already understood.

## Two surfaces, two voices

- **Marketing** (the `welcome` plugin, signed-out landing): end-user, warm, leads with
  the *why*. Owns the copy below.
- **Docs** (the `documentation` plugin): builder-facing, factual, leads with the *how*.
  Once `welcome` exists, pull landing-page duty off the docs plugin.

## Hero copy (end-user marketing — current draft)

> # Stop building islands.
>
> **Canopy is one place for your files, calendar, tasks, and notes — kept in storage
> you own, with an assistant that can see across all of it.**
>
> Open it in your browser and it feels familiar: a drive, a calendar, a to-do list,
> your documents. What's different is underneath — it's all one connected system. Ask
> *"what did the Berlin trip cost?"* and your assistant pulls the dates from your
> calendar and the receipts from your files, together, without you setting anything up.
>
> It doesn't stop at what's built in. Want a workout log, a reading list, a budget
> tracker? Add one in minutes — or install one someone else made. Because everything
> runs on the same system, whatever you add just works with the rest, and your
> assistant understands it too.
>
> That's what makes Canopy an **operating system for your data and your life**: one
> place where your files live, your apps fit together, and your assistant always knows
> where everything is.

### Page arc (for building out the landing below the hero)
No islands → it compounds → your assistant actually understands your life → no ceiling.

### Headlines in reserve
- Promise-first (softer than the enemy frame): *"Build apps in minutes. They all fit together."*
- OS-forward (developer / investor surface): *"An operating system for your data and your life. Not another app — the ground the apps stand on."*

## Docs intro (builder-facing — factual)

> Canopy is an extensible, AI-native portal. The first app is a **drive** over
> bring-your-own storage (local filesystem, Cloudflare R2, or a connected source like a
> NAS or GitHub repo). The same slim shell hosts first-party apps — calendar, tasks,
> documentation — and sandboxed plugins right alongside them. This documentation covers
> how it's built and how to extend it.
