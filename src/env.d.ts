declare module '*.css' {
  const css: string;
  export default css;
}

/** Injected by esbuild (scripts/build.mjs). */
declare const __VERSION__: string;
declare const __E2E__: boolean;
