// Canopy app plugin shipped as an npm package. The importer reads the manifest from
// package.json's "canopy" field and only accepts a self-contained ES module (no imports).
export default function render({ container }) {
  container.textContent = "npm sample app is running";
}
