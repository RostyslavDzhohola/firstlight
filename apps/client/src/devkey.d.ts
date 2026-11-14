/** Dev sign-in codes are on (#84): true on the root `pnpm dev`'s dev server, a literal false in every
 *  build (vite.config.ts) and in the tests (vitest.config.ts), so the bundler drops the code fetch. */
declare const __FL_DEV_CODES__: boolean;
