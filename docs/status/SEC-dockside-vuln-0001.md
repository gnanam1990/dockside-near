# SEC vuln-0001 — manifest `commit` reached `git diff` as an option (and cmd.exe on Windows)

- Source: external automated scan, finding vuln-0001 (MEDIUM, CWE-88). Verified independently on the real code.
- Branch: `feat/dockside-m20-manifest-git-arg-injection`, base main `2293bc5`.
- Area: `scripts/build-manifest.mjs` (`verify()` and the `run()` helper), T-045.

## Finding

`node scripts/build-manifest.mjs --verify <manifest>` passed the manifest's `commit` string unchecked to
`git diff --name-only <commit> <HEAD>`, and `run()` used `execFileSync(..., { shell: true })` for every command on
Windows. A manifest is an input that may come from elsewhere (the CI chain job uploads one as an artifact), so:

- `"commit": "--output=<file>"` made git truncate `<file>` and print nothing, and the verifier then reported
  `ok: true` with no problems;
- on Windows, `"commit": "x & echo PWNED> <file> & rem"` was joined into a cmd.exe command line and executed.

Verified: confirmed on the Windows host, both cases (the scanner had only reasoned about the Windows path).

## Fix

- The manifest commit is accepted only as a string matching a full SHA-1 or SHA-256 object id
  (`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`); anything else is the problem `commit "<value>" is not a full commit id`
  and never reaches git.
- The `git diff` argument list ends with `--`.
- On Windows only the `pnpm` shim runs through a shell; `git`, `rustc` and `cargo` are real executables and now run
  without one. The manifest's `toolchain` fields are unchanged (checked on the Windows host).

An honest manifest behaves as before: an ancestor commit whose later changes are documentation only verifies `ok`,
one with later code changes reports `files other than documentation changed ...`, and an unknown 40-hex commit
reports `is not in this repository`.

## Reproduction (Windows host, `<tmp>` is a scratch directory)

`good.json` from `node scripts/build-manifest.mjs --out <tmp>/good.json`; `evil.json` sets
`commit` to `--output=<tmp>/victim.txt`; `evil2.json` sets it to `x & echo PWNED> <tmp>/pwned.txt & rem`.

| Step | Command | Exit | Result |
|---|---|---|---|
| Before fix | `node scripts/build-manifest.mjs --verify <tmp>/evil.json` | 0 | `ok: true`, `problems: []`; `victim.txt` truncated from 28 to 0 bytes |
| Before fix | `node scripts/build-manifest.mjs --verify <tmp>/evil2.json` | 0 | `ok: true`; `<tmp>/pwned.txt` created containing `PWNED` (command executed) |
| After fix | `node scripts/build-manifest.mjs --verify <tmp>/evil.json` | 1 | `ok: false`, `commit "--output=<tmp>/victim.txt" is not a full commit id`; victim unchanged (28 bytes) |
| After fix | `node scripts/build-manifest.mjs --verify <tmp>/evil2.json` | 1 | `ok: false`, `... is not a full commit id`; no `pwned.txt` |
| After fix, honest docs-only ancestor (`0e15dc0`, full id) | `--verify` | 0 | `ok: true` |
| After fix, honest older ancestor (`d19860d`, full id) | `--verify` | 1 | `files other than documentation changed since the manifest commit: ...` |

## Tests (red before green)

New case in `services/api/test/m09-t045-build-manifest.test.ts`: crafted commits `--output=<file>`,
`x & echo PWNED> <file> & rem`, `x; echo PWNED > <file>`, `HEAD`, upper-case 40-hex, and a JSON array must each give
exit 1 with `is not a full commit id`, the victim file must keep its content and no marker file may appear; an honest
full parent id must still reach git (skipped in a shallow checkout).

| Step | Command | Exit | Result |
|---|---|---|---|
| Before fix | `npx vitest run services/api/test/m09-t045-build-manifest.test.ts` | 1 | 1 failed, 3 passed (`--output=...: expected +0 to be 1`) |
| After fix | same command | 0 | 4 passed |
| Workflow policy | `pnpm run ci:policy` | 0 | `violations: []` |
| Full suite (after `git merge main`) | `pnpm run check` | 0 | format, lint, typecheck, 53 test files passed, 1 skipped; 578 tests passed, 3 skipped; secret-scan clean (492 files) |

Browser e2e, contract and delivery suites were not re-run: the change is limited to the manifest verifier's commit
handling and the shell flag for non-pnpm commands in that one script; manifest generation is covered by the T-045 test.

## Remaining

None for this finding. Other scripts that pass `shell: true` on Windows build their arguments from repository-controlled
values, not from a downloaded manifest.
