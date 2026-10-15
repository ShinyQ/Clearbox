// The web tsconfig deliberately excludes Node types; setup.ts only needs this one default export.
declare module "node:console" {
  const nativeConsole: Console;
  export default nativeConsole;
}
