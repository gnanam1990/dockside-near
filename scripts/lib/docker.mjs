// Docker command and host-path handling shared by the container scripts
// (scripts/container-reproduce.mjs, scripts/sandbox/run.mjs).
//
// DOCKSIDE_DOCKER overrides the docker command, for example
// "wsl.exe -d Ubuntu-24.04 -u root -- docker" on a Windows host whose Docker Engine runs in WSL;
// host paths are then translated to /mnt/<drive>/... for the Linux side.
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

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
