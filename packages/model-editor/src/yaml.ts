/**
 * The one place spec YAML is parsed and written, pinned to a schema on purpose.
 *
 * js-yaml 5 dropped its default export and changed what `load` resolves by default,
 * and the change is silent: nothing throws, the document just comes back different.
 * A differential run of v4 against v5 on spec-shaped input found:
 *
 * - **Merge keys stopped resolving.** `<<: *defaults` came back as a literal `"<<"`
 *   key instead of merged fields. Anchors plus merge keys are common in OpenAPI and
 *   AsyncAPI files, so this is the change that would quietly corrupt a model.
 * - **`YAML11_SCHEMA` is not the way back.** It parses the KEYS `y` and `n` as the
 *   booleans `true` and `false`, so a field named `y` became `"true"` — worse than
 *   the problem it would fix.
 *
 * `CORE_SCHEMA` plus the merge tag matches v4 on everything tested (booleans, `y`/`n`
 * keys, numbers, version strings, status-code keys, single and list merges, merge
 * overrides) except one: a date stays the string it was written as. v4 turned
 * `2026-09-22` into a `Date` and it reached the model as `2026-09-22T00:00:00.000Z`,
 * which is not what the file said and not what JSON Schema's `format: date` expects.
 * That difference is the fix, not a regression.
 */
import { CORE_SCHEMA, dump, load, mergeTag } from "js-yaml";

const SPEC_SCHEMA = CORE_SCHEMA.withTags([mergeTag]);

export const loadYaml = (text: string): unknown => load(text, { schema: SPEC_SCHEMA });

export const dumpYaml = (value: unknown, options?: Parameters<typeof dump>[1]): string =>
  dump(value, options);
