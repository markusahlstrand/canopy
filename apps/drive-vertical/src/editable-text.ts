const SOURCE_EXTENSIONS = new Set('txt text log js jsx mjs cjs ts tsx json jsonc html htm css scss less py rb go rs java c h cpp cc hpp cs php swift kt kts sh bash zsh sql yaml yml toml xml ini env lua r pl dockerfile vue svelte graphql proto md markdown mdx'.split(' '));
/** MIME labels on browser uploads can be empty or misleading for source files. */
export function editableTextMime(mime: string, name = ''): boolean {
 const type=mime.split(';')[0]!.trim().toLowerCase();
 const extension=name.toLowerCase().split('.').pop() ?? '';
 // A .locked file's label says nothing about it; what may be written is checked by `lockedEnvelope`.
 if (isLockedName(name)) return true;
 return type.startsWith('text/') || type==='application/json' || type.endsWith('+json') || type==='application/xml' || type==='application/javascript' || (['application/octet-stream','video/mp2t','application/x-typescript','application/x-python','application/x-yaml'].includes(type) && name.includes('.') && SOURCE_EXTENSIONS.has(extension));
}

/** A .locked file holds text encrypted in the browser by the Locked Notes plugin. */
export const isLockedName = (name: string): boolean => name.toLowerCase().endsWith('.locked');

/** Only an encrypted envelope may be saved over a .locked file, so no editor can write plain text into one. */
export function lockedEnvelope(text: string): boolean {
 try {
  const doc=JSON.parse(text) as {format?:unknown;cipher?:{iv?:unknown};data?:unknown};
  return doc?.format==='canopy-locked' && typeof doc.cipher?.iv==='string' && typeof doc.data==='string';
 } catch { return false; }
}
