import { validatePlugin } from './index.mjs';
const args = process.argv.slice(2);
const manifestOnly = args.includes('--manifest-only');
const generated = args.includes('--generated');
const json = args.includes('--json');
const targets = args.filter(arg => !['--manifest-only', '--generated', '--json'].includes(arg));
const usage = 'Usage: pnpm plugin:validate [--manifest-only] [--generated] [--json] <plugin-directory-or-canopy.json>';

function report(result) {
  if (json) {
    console.log(JSON.stringify({ formatVersion: 1, valid: result.valid, errors: result.errors,
      profile: generated ? 'generated' : 'portable', manifestOnly,
      ...(result.valid ? { plugin: { id: result.manifest.id, version: result.manifest.version } } : {}),
    }));
  } else if (result.valid) console.log(`Valid ${manifestOnly ? "manifest" : "plugin"}: ${result.manifest.id}@${result.manifest.version}`);
  else for (const error of result.errors) console.error(error);
}

if (targets.length !== 1 || targets[0].startsWith('-')) {
  report({ valid: false, errors: [usage] });
  process.exitCode = 2;
} else {
  try {
    const result = await validatePlugin(targets[0], { manifestOnly, generated });
    report(result);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    report({ valid: false, errors: [`${targets[0]}: ${error.message}`] });
    process.exitCode = 1;
  }
}
