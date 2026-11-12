# SEC m25 — quadratic PDF text-extraction regex with a post-hoc parse-time limit

- Source: external security audit, confirmed finding 1 (medium),
  `dockside:evidence:sniff:pdfStrings-quadratic-regex-post-hoc-parse-time`. Treated as an unverified claim and
  reproduced independently on the real code before any change.
- Verdict: **confirmed, fixed**.
- Branch: `feat/dockside-m25-pdf-regex-redos`, base main `49fbaf7`.
- Spec: TDD.md (evidence intake) makes parse time a per-slot parser-resource limit; SECURITY.md requires bounded
  untrusted-input handling. The sealed spec under `docs/spec/` was not edited.

## The issue

`classify()` (`packages/evidence/src/sniff.ts`) runs synchronously in the API process from
`EvidenceService.upload`. For a PDF, `sniffPdf` ran `pdfStrings()` over every (possibly Flate-inflated) stream
with the regex `/\(((?:\\.|[^\\)])*)\)\s*T[jJ]/g`. For N unclosed `(` every start position rescans the rest of
the run, so the work is O(N^2). `maxParseTimeMs` was only compared after the whole parse had finished, so it
did not bound the work. A 194-byte Flate upload inflating to 64,000 `(` held the event loop for seconds.

## Reproduction (red)

Test written first: `packages/evidence/test/sec-m25-pdf-regex-redos.test.ts` (real `classify`, slot limit
`maxParseTimeMs: 100`, `maxDecompressedBytes: 1048576`).

```
npx vitest run packages/evidence/test/sec-m25-pdf-regex-redos.test.ts     # on main 49fbaf7 code
exit 1 — Tests 2 failed | 1 passed (3)
  × scans 64000 unclosed '(' in a raw stream within about the parse deadline     5009ms
      expected 5002.1533 to be less than 200
  × scans 64000 unclosed '(' in a Flate stream within about the parse deadline   5459ms
      expected 5455.78 to be less than 200
  ✓ extracts the same strings as the original rule
```

## Fix

- `pdfStrings` is now a single forward scanner. Every `(` still open when the scan reaches an unescaped `)`, or
  a backslash before a line end (where `\\.` cannot match), shares that outcome, so no position is rescanned.
  It produces exactly the same matches and unescaping as the previous regex. The behaviour test compares it with
  the original regex on fixed edge cases and 2,000 seeded random strings.
- `sniffPdf` receives the slot deadline (`t0 + maxParseTimeMs`) and checks it before and after each stream's
  extraction and every 64 Ki characters inside the scanner. When the deadline passes it fails with
  `LIMIT_EXCEEDED` "parse time over limit" (the same code and message as the existing post-hoc check, which
  stays in place).
- Not changed: the order of classification and issuer verification in `EvidenceService.upload`. With linear
  extraction bounded by `maxDecompressedBytes` and the in-parse deadline, the parser's cost per upload is bounded
  by the slot limits, and content rejections keep their spec quarantine path.

## After (green)

```
npx vitest run packages/evidence/test/sec-m25-pdf-regex-redos.test.ts packages/evidence/test/sec-vuln-0003-pdf-stream-dict.test.ts
exit 0 — Tests 9 passed (9)
  ✓ raw 64000 unclosed '('     7ms
  ✓ Flate 64000 unclosed '('   3ms
  ✓ extracts the same strings as the original rule
```

Full-suite results after merging main are recorded below.
