import Ajv from 'ajv';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
const schema = JSON.parse(await readFile(new URL('../../../documentation/canopy-plugin.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);

/** Inspect files and declarations only; plugin code is never imported or executed. */
export async function validatePlugin(input) {
  const target = resolve(input);
  const manifestPath = (await stat(target)).isDirectory() ? resolve(target, 'canopy.json') : target;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!validate(manifest)) return { valid: false, errors: validate.errors.map(error => `${error.instancePath || '/'} ${error.message}${error.params.additionalProperty ? `: ${error.params.additionalProperty}` : ''}`) };
  const root = await realpath(dirname(manifestPath));
  const entry = manifest.entry ?? 'index.js';
  if (isAbsolute(entry)) return { valid: false, errors: ['entry must be relative to the plugin directory'] };
  try {
    const location = await realpath(resolve(root, entry));
    const inside = relative(root, location);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { valid: false, errors: ['entry must remain inside the plugin directory'] };
    if (!(await stat(location)).isFile()) return { valid: false, errors: ['entry must name a file'] };
  } catch {
    return { valid: false, errors: [`entry not found: ${entry}`] };
  }
  return { valid: true, errors: [], manifest };
}
