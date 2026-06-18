// SVG imports resolve to a URL string under both consumers' Vite builds. Declare
// it locally so the shell type-checks standalone, independent of which app's
// vite/client types are in scope.
declare module '*.svg' {
  const src: string
  export default src
}
