import { validatePlugin } from './index.mjs';
if (process.argv.length !== 3) {
  console.error('Usage: pnpm plugin:validate <plugin-directory-or-canopy.json>');
  process.exitCode = 2;
} else {
  try {
    const result = await validatePlugin(process.argv[2]);
    if (result.valid) console.log(`Valid plugin: ${result.manifest.id}@${result.manifest.version}`);
    else { for (const error of result.errors) console.error(error); process.exitCode = 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
