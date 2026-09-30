# Viewers in the hosted drive

The hosted drive bundles its viewers at build time. `@canopy/plugin-sdk/web-component`
defines the small `ViewerFile` property that the preview host passes to a custom
element. The first consumer is the image viewer, ported from
`examples/plugins/image-viewer` into `apps/drive-vertical/app/src/image-viewer.ts`.
It keeps the original viewer's no-upscale behavior and reads bytes through the
drive's permission-checked, same-origin content route.

## Which plugins move

- First-party viewers that only display a file can be bundled with the vertical
  after review. The image viewer is the proof. A future viewer that saves content
  needs an explicit write capability and a versioned operation; this read-only
  contract does not imply one.
- Plugins that call external services need declared egress and a reviewed build.
  They cannot fetch arbitrary hosts from a hosted vertical.
- Runtime-installed third-party plugins, the plugin browser and the studio stay
  on Canopy's own portal deployment. Adding one to a hosted drive requires a new
  build and deploy, not an install action in the browser.

## Trust boundary

A web component shares the host page's origin and JavaScript realm. Its `ViewerFile`
property is a convenient API, **not a security boundary**: code in that realm can
reach the DOM, storage and same-origin routes regardless of the property. Only
trusted, reviewed code is bundled. The portal's existing iframe viewer remains the
isolation mechanism for runtime-installed code on Canopy's own deployment. Shadow
DOM only isolates the viewer's layout and styles.

The host never sends an authentication token to the viewer. The content URL goes
through the same checked attachment route as the built-in preview. The component
must still be treated as privileged code during review, and Substrat's binding and
egress declarations apply to the whole deployed vertical, including its viewers.
