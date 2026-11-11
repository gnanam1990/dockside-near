/**
 * Module resolution for the local stack (scripts/local-stack/stack.ts), run by Node's built-in
 * TypeScript support (`--experimental-transform-types`).
 *
 * - `@dockside/<pkg>` resolves to the compiled workspace package (`pnpm run build` first), so the
 *   stack runs exactly the code the API ships.
 * - A relative `./x.js` import whose `.js` file does not exist resolves to `./x.ts`. This lets the
 *   stack load the simulated NEAR host and its JSON-RPC server from the test tree, which are
 *   TypeScript sources with `.js` import specifiers.
 */
import { register } from "node:module";

register(new URL("./resolve-hooks.mjs", import.meta.url));
