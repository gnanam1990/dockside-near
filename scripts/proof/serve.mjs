// Static file server for the proof page (site/proof), for a local preview and the browser suite.
// GitHub Pages serves the same files unchanged; this server adds nothing to them.
//
// Usage: node scripts/proof/serve.mjs [--port 9041]      then open http://127.0.0.1:9041/
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "../../site/proof");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * @param {{port?: number, root?: string}} [options]
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export function startSite({ port = 0, root = SITE } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const file = resolve(join(root, path.endsWith("/") ? `${path}index.html` : path));
    const type = TYPES[extname(file)];
    if ((req.method !== "GET" && req.method !== "HEAD") || !file.startsWith(root + sep) || !type) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  return new Promise((ok, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", () => {
      ok({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 9041;
  const site = await startSite({ port });
  process.stdout.write(`proof page: ${site.url}\n`);
}
