// Side-effect CSS imports (e.g. React Flow's stylesheet) are resolved by the
// bundler (Vite/esbuild) in every host. Declare the module so the package's own
// `tsc` typecheck — which has no bundler-provided ambient types — accepts them.
declare module "*.css";
