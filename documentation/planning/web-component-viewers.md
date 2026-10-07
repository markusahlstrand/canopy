# Viewers in the hosted drive

> Historical decision record for the bundled image viewer. The drive now also has a reviewed runtime plugin installer and an opaque-origin iframe host. See [How plugins work](../03-how-plugins-work.md) for current behavior.

The hosted drive bundles its first-party image viewer at build time. `@canopy/plugin-sdk/web-component`
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
- Bundled components that call external services need declared egress and a reviewed
  build. Runtime iframe plugins declare allowed network hosts in their manifest
  and require install-time capability approval.
- The old portal's installs did not migrate. The current drive has a separate
  runtime installer for ZIP, public GitHub, and npm sources; those plugins run in
  opaque-origin iframes after capability review. The bundled web-component path
  still requires a build and deploy.

## Trust boundary

A web component shares the host page's origin and JavaScript realm. Its `ViewerFile`
property is a convenient API, **not a security boundary**: code in that realm can
reach the DOM, storage and same-origin routes regardless of the property. Only
trusted, reviewed code is bundled. The retired portal's iframe host provided a
different isolation model. The drive's new runtime iframe host is separate from
this trusted web-component path. Shadow DOM only isolates the bundled viewer's
layout and styles.

The host never sends an authentication token to the bundled viewer. The content URL goes
through the same checked attachment route as the built-in preview. The component
must still be treated as privileged code during review, and Substrat's binding and
egress declarations apply to the whole deployed vertical, including its viewers.
