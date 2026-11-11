import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The web app is served from its own origin and proxies the API paths to the control API,
 * so DOCKSIDE_ORIGIN (bound into every proof) equals the page origin. The production
 * preview server sends a strict CSP: no inline script, no third-party origins.
 */
const api = process.env["DOCKSIDE_API_URL"] ?? "http://127.0.0.1:8787";
/** Optional relayer for contract calls (the local stack serves one for its simulated chain). */
const relayer = process.env["DOCKSIDE_RELAYER_URL"];
const proxy: Record<string, { target: string; changeOrigin: boolean }> = {
  "/v1": { target: api, changeOrigin: false },
  "/healthz": { target: api, changeOrigin: false },
  "/readyz": { target: api, changeOrigin: false },
  ...(relayer ? { "/relay": { target: relayer, changeOrigin: false } } : {}),
};

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig({
  plugins: [react()],
  build: { assetsInlineLimit: 0, sourcemap: true, target: "es2022" },
  server: { proxy, strictPort: true },
  preview: {
    proxy,
    strictPort: true,
    headers: {
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});
