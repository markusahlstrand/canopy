# How plugins work

The old portal's sandboxed iframe plugin runtime was retired with <code>apps/portal</code>. Its manifest and capability model remains in legacy packages, but the current Substrat drive vertical does not load runtime plugins.

The replacement is being decided in [#73: Web components and the hosted vertical](https://github.com/markusahlstrand/canopy/issues/73). That decision must settle which viewer roles can be bundled, what a component may receive from the host, and what happens to plugin authoring and installation. The [Substrat manifest work](https://github.com/markusahlstrand/canopy/issues/46) follows that boundary.

The old design and implementation can be read in repository history. Do not use it as a contract for the running vertical.
