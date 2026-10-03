import Ajv from 'ajv';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
const schema = JSON.parse(await readFile(new URL('../../../documentation/canopy-plugin.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true }).compile(schema);

/** Resolve a JSON pointer like `#/definitions/capability/oneOf` against the schema. */
function schemaAt(pointer) {
  return pointer.replace(/^#\/?/, '').split('/').filter(Boolean)
    .reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], schema);
}

function valueAt(document, instancePath) {
  return instancePath.split('/').slice(1).reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document);
}

/**
 * A `oneOf` whose branches are told apart by a `kind` const (capabilities) fails
 * every branch at once, and Ajv reports each miss. Keep only what helps the author:
 * an unknown kind becomes one line naming the allowed kinds, and a known kind keeps
 * only the errors from its own branch.
 */
function collapseKindUnions(errors, manifest) {
  let result = errors;
  for (const union of errors.filter(error => error.keyword === 'oneOf')) {
    const branches = schemaAt(union.schemaPath);
    const kinds = Array.isArray(branches) ? branches.map(branch => branch?.properties?.kind?.const) : [];
    if (!kinds.length || kinds.some(kind => typeof kind !== 'string')) continue;
    const prefix = `${union.instancePath}/`;
    const within = error => error.instancePath === union.instancePath || error.instancePath.startsWith(prefix);
    const branchOf = error => error.schemaPath.startsWith(`${union.schemaPath}/`)
      ? Number(error.schemaPath.slice(union.schemaPath.length + 1).split('/')[0]) : -1;
    const kind = valueAt(manifest, `${union.instancePath}/kind`);
    const match = kinds.indexOf(kind);
    result = result.filter(error => !(within(error) && (error === union || branchOf(error) >= 0)));
    if (match >= 0) result.push(...errors.filter(error => within(error) && branchOf(error) === match));
    else result.push({ instancePath: `${union.instancePath}/kind`, message: `${JSON.stringify(kind)} is not one of ${kinds.join(', ')}`, params: {} });
  }
  return result;
}

function describe(error) {
  const { additionalProperty, allowedValue, allowedValues } = error.params;
  const detail = additionalProperty ? `: ${additionalProperty}`
    : allowedValues ? `: ${allowedValues.map(value => JSON.stringify(value)).join(', ')}`
    : allowedValue !== undefined ? `: ${JSON.stringify(allowedValue)}` : '';
  return `${error.instancePath || '/'} ${error.message}${detail}`;
}

/**
 * Loaders look the entry up literally (the zip loader by exact key, the GitHub
 * loader by URL, which normalises `..` itself), so "valid" may only accept a
 * path every loader reads the same way: plain `/`-separated names, nothing to
 * normalise.
 */
function entryProblem(entry) {
  if (isAbsolute(entry) || entry.startsWith('/')) return 'entry must be relative to the plugin directory';
  if (entry.includes('\\')) return 'entry must use "/" separators';
  if (entry.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return `entry must be a plain relative path without empty, "." or ".." segments: ${entry}`;
  return null;
}

/**
 * Inspect files and declarations only; plugin code is never imported or executed.
 * `manifestOnly` skips the entry check for plugins whose code ships with the host.
 */
export async function validatePlugin(input, { manifestOnly = false } = {}) {
  const target = resolve(input);
  const manifestPath = (await stat(target)).isDirectory() ? resolve(target, 'canopy.json') : target;
  let manifest;
  try {
    manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^﻿/, ''));
  } catch (error) {
    return { valid: false, errors: [`${manifestPath}: ${error.message}`] };
  }
  if (!validate(manifest)) return { valid: false, errors: collapseKindUnions(validate.errors, manifest).map(describe) };
  if (manifestOnly) return { valid: true, errors: [], manifest };
  const entry = manifest.entry ?? 'index.js';
  const problem = entryProblem(entry);
  if (problem) return { valid: false, errors: [problem] };
  const root = await realpath(dirname(manifestPath));
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
