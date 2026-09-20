/**
 * The entity model, rendered to the artifact `substrat push` reads.
 *
 * `push` looks for `model.json` beside the pushed package.json — here, not in
 * `packages/scope-drive` where the entities are declared — and a version pushed
 * without one records no entity model at all. The dashboard's Model tab is then
 * empty for code that plainly has a model, and the first place anyone learns it
 * is after a successful deploy. This script and the `lint:model` gate move that
 * discovery to before the upload.
 *
 * It reads the SAME object the vertical bundles (`driveModel`, an `emitModel(...)`
 * result exported from the spec), so the artifact cannot drift from what the code
 * declares. Deterministic: `emitModel` sorts entities and their fields, so a
 * reordered declaration is not a spurious diff.
 *
 * The JSON is the artifact of record — everything downstream should read it
 * rather than the TypeScript, which is what keeps the authoring notation
 * swappable.
 *
 * Mirrors substrat's own `tools/model-diff.mts`, including its exit codes:
 *   0 = fine, 1 = drift (the gate firing), 2 = the tool could not do its job.
 * A gate that checked nothing must never print a green light.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const check = process.argv.slice(2).includes('--check');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'model.json');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message) {
  console.error(`emit-model: ${message}\n`);
  process.exit(2);
}

let driveModel;
try {
  ({ driveModel } = await import('@canopy/scope-drive/spec/model'));
} catch (e) {
  // A module that will not load is the tool being unable to do its job, not drift —
  // and re-running the emitter cannot fix it. The usual cause is an unbuilt dist.
  cannot(
    `@canopy/scope-drive/spec/model could not be imported — ${e instanceof Error ? e.message : String(e)}\n` +
      '  The model is not stale, it is unreadable.\n' +
      '  Remedy: build the package first (`pnpm --filter @canopy/scope-drive build`).',
  );
}

if (!driveModel || typeof driveModel !== 'object' || !driveModel.entities) {
  cannot(
    'the spec exports no `driveModel` shaped like an emitted model.\n' +
      '  Remedy: `export const driveModel = emitModel(driveEntities)` from packages/scope-drive/spec/model.ts.',
  );
}

const rendered = `${JSON.stringify(driveModel, null, 2)}\n`;
const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
const entities = Object.keys(driveModel.entities).length;

if (check) {
  if (current !== rendered) {
    console.error(
      `emit-model: ${target} is ${current === null ? 'missing' : 'stale'} — re-run \`pnpm model:emit\` and commit the diff`,
    );
    process.exit(1);
  }
  console.log(`emit-model: model.json is current (${entities} entities)`);
} else if (current !== rendered) {
  writeFileSync(target, rendered);
  console.log(`emit-model: wrote ${target} (${entities} entities)`);
} else {
  console.log(`emit-model: ${target} already current (${entities} entities)`);
}
