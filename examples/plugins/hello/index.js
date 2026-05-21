// A tiny Canopy plugin. The host runs `enrichItem` (a server hook) in the
// plugin runtime and merges the returned fields into the item's details.
export function enrichItem(item) {
  return { greeting: `Hello, ${item.name}!` };
}
