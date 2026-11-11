import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url);

const PACKAGES = {
  "@dockside/core": "packages/core/dist/index.js",
  "@dockside/store": "packages/store/dist/index.js",
  "@dockside/near": "packages/near/dist/index.js",
  "@dockside/authority": "packages/authority/dist/index.js",
  "@dockside/evidence": "packages/evidence/dist/index.js",
  "@dockside/release": "packages/release/dist/index.js",
  "@dockside/journal": "packages/journal/dist/index.js",
  "@dockside/payout": "packages/payout/dist/index.js",
  "@dockside/api": "services/api/dist/app.js",
  "@dockside/worker": "services/worker/dist/index.js",
};

export async function resolve(specifier, context, next) {
  const mapped = PACKAGES[specifier];
  if (mapped) {
    const url = new URL(mapped, ROOT);
    if (!existsSync(fileURLToPath(url)))
      throw new Error(`${specifier} is not built (${mapped}); run \`pnpm run build\` first`);
    return { url: url.href, shortCircuit: true, format: "module" };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
    const js = new URL(specifier, context.parentURL);
    if (js.protocol === "file:" && !existsSync(fileURLToPath(js))) {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(pathToFileURL(fileURLToPath(ts)).href, context);
    }
  }
  return next(specifier, context);
}
