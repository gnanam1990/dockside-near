// Docker command and host-path handling shared by the container scripts
// (scripts/container-reproduce.mjs, scripts/sandbox/run.mjs).
//
// DOCKSIDE_DOCKER overrides the docker command, for example
// "wsl.exe -d Ubuntu-24.04 -u root -- docker" on a Windows host whose Docker Engine runs in WSL;
// host paths are then translated to /mnt/<drive>/... for the Linux side.
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

// Official Node.js images pinned by digest (the multi-platform index digest), so a moved tag cannot
// change the build environment (ADR-0021). The tag stays in the reference for readability; Docker
// pulls by the digest. Bump both together, deliberately, and re-run the reproduction.
export const IMAGES = Object.freeze({
  // The deployable-wasm build (scripts/container-reproduce.sh, ADR-0015).
  bookworm: "node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee",
  // The real-chain suites (scripts/sandbox/container-sandbox.sh, ADR-0019): nearcore needs glibc 2.38+.
  trixie: "node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64",
});

export function dockerCommand(env = process.env) {
  return (env.DOCKSIDE_DOCKER || "docker").split(" ").filter(Boolean);
}

export function viaWsl(docker) {
  return /(^|[\\/])wsl(\.exe)?$/i.test(docker[0] ?? "");
}

/** The path as the Docker Engine sees it. */
export function hostPath(p, docker) {
  const abs = resolve(p);
  if (!viaWsl(docker)) return abs;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].split("\\").join("/")}` : abs.split("\\").join("/");
}

/** The shared git directory (a worktree's .git is a file, so containers clone from this). */
export function gitCommonDir(root) {
  let gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  if (!isAbsolute(gitDir)) gitDir = resolve(root, gitDir);
  return gitDir;
}
