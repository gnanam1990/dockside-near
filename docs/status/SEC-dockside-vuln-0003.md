# SEC vuln-0003 — PDF sniffer missed a stream /Filter hidden by a nested dictionary

- Source: external automated scan, finding vuln-0003 (LOW, CWE-436). Verified independently on the real code.
- Branch: `feat/dockside-m22-pdf-sniffer-nested-dict`, base main `2293bc5`.
- Area: `packages/evidence/src/sniff.ts` (`sniffPdf`, parser profile `dockside-sniff@1`).

## Finding

`sniffPdf` decided whether a stream was Flate-compressed from `s.slice(max(last, s.lastIndexOf("<<", m.index)), m.index)`,
i.e. only the text after the last `<<` before the `stream` keyword. For a dictionary such as
`<< /Type /ObjStm /Filter /FlateDecode /DecodeParms << /Predictor 1 >> /Length N >>` that slice starts at the nested
`<<`, so `/Filter /FlateDecode` was not seen, the compressed body was treated as raw bytes and never inflated, and any
`/OpenAction`, `/JS` or `/JavaScript` inside it went unscanned. The same path skipped the decompressed-size and ratio
checks and the text extract for that stream, and an unsupported filter (e.g. `/LZWDecode`) placed before a nested
dictionary was accepted instead of refused.

Verified: confirmed. An authorized uploader could store a PDF with active content in a compressed object stream.

## Fix

The stream dictionary is now the whole region since the end of the previous stream (`s.slice(last, m.index)`), so a
nested dictionary cannot hide the stream's `/Filter`. This fails closed: a `/Filter` in an earlier stream-less object
in the same region (for example a signature dictionary) makes the next stream be inflated or refused as
`UNSUPPORTED_CONTENT`, never accepted unscanned. No other sniffer behaviour changed.

## Tests (red before green)

New file `packages/evidence/test/sec-vuln-0003-pdf-stream-dict.test.ts` (6 cases): plain `/Filter` (control),
`/Filter` before nested `/DecodeParms`, `/DecodeParms` before `/Filter`, `/Filter` array with nested dict array,
unsupported filter before a nested dict, and a benign compressed stream with nested `/DecodeParms` whose text is
still extracted.

| Step | Command | Exit | Result |
|---|---|---|---|
| Before fix | `npx vitest run packages/evidence/test/sec-vuln-0003-pdf-stream-dict.test.ts` | 1 | 4 failed, 2 passed: the nested-dict cases were accepted (`expected undefined to be 'MALICIOUS_CONTENT'`, `expected undefined to be 'UNSUPPORTED_CONTENT'`) and the benign text extract was empty |
| After fix | same command | 0 | 6 passed |
| Full suite (after `git merge main`, already up to date) | `pnpm run check` | 0 | format, lint, typecheck, 53 test files passed, 1 skipped; 577 tests passed, 3 skipped; secret-scan clean |

Browser e2e, contract and delivery suites were not re-run: the change is limited to the sniffer's stream-dictionary
slice, and the e2e PDF fixtures (`apps/web/e2e/stack.ts`) contain no `/Filter`, so their classification is unchanged.

## Remaining

`dockside-sniff@1` is still a token scanner, not a full PDF parser. The fix closes this bypass by over-approximating
the dictionary region; a real parser for object and filter resolution remains a possible later hardening step.
