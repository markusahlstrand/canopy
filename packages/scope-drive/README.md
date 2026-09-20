# @canopy/scope-drive

The drive, modelled as a Substrat module: **a space is a scope**, so the space id stops
being a column and becomes the database.

This is the first executable piece of the re-platform (rail S9/S10). It is not a port of
`@canopy/store` — the store's shape cannot survive the move, because every table there
carries `tenant_id` and every query filters on it. Here there is nothing to filter by.

```
spec/model.ts   entities (folder, file, file_version) + operations, declared once
src/migrations  the scope-local schema — no space id, asserted by the suite
src/module.ts   handlers on ctx.sql: one hop, then local queries
test/           what the move has to keep true
```

Run it:

```sh
pnpm --filter @canopy/scope-drive test
```

What it proves and what it deliberately does not: see
[`documentation/planning/scope-model-mapping.md`](../../documentation/planning/scope-model-mapping.md).
