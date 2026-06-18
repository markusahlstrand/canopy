// Side-effect CSS imports are resolved by Vite at build time; declare the module
// so `tsc --noEmit` (which has no bundler ambient types) accepts them.
declare module "*.css";
