import { validatePlugin } from './index.mjs';
const args = process.argv.slice(2);
const manifestOnly = args.includes('--manifest-only');
const generated = args.includes('--generated');
const targets = args.filter(arg => !['--manifest-only', '--generated'].includes(arg));
if (targets.length !== 1 || targets[0].startsWith('-')) {
  console.error('Usage: pnpm plugin:validate [--manifest-only] [--generated] <plugin-directory-or-canopy.json>');
  process.exitCode = 2;
} else {
  try {
    const result = await validatePlugin(targets[0], { manifestOnly, generated });
    if (result.valid) console.log(`Valid ${manifestOnly ? "manifest" : "plugin"}: ${result.manifest.id}@${result.manifest.version}`);
    else { for (const error of result.errors) console.error(error); process.exitCode = 1; }
  } catch (error) { console.error(`${targets[0]}: ${error.message}`); process.exitCode = 1; }
}
