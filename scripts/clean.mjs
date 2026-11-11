import { rmSync } from "node:fs";

for (const p of [
  "packages/core/dist",
  "packages/store/dist",
  "packages/authority/dist",
  "services/api/dist",
]) {
  rmSync(p, { recursive: true, force: true });
}
