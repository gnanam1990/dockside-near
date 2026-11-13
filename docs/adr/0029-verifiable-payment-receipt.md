# ADR-0029 — Verifiable payment receipt

- Decision status: accepted (M54)
- Date: 2026-11-13, Dockside platform team (M54)
- Affected IDs: FR-15 (export), NFR-02 (no secrets), NFR-06 (verifiable records); amends ADR-0018 §5 (the
  audit-export key may sign a third purpose) and ADR-0027 (the proof site gains a receipt page; the hosted front
  serves the proof site)
- Beyond the spec: `docs/spec/` asks for no payment receipt. The receipt is an addition for the buyer, the supplier
  and whoever they show it to. It changes no contract, no trade state and no claim level.

## Context

After a trade is PAID, the supplier (or the buyer's finance team, or an auditor) wants one document that says who
paid whom, how much, in which asset, on which inspection result, and in which transaction. A PDF from our server
alone proves only that our server said so. The receipt must therefore be checkable without trusting our server, by
someone who has only the paper or the file.

## Decisions

1. **Two halves, both verifiable.** The *receipt page* re-checks the payment on NEAR in the reader's browser; the
   *signed PDF* carries what our deployment recorded, signed by its audit-export key, and the address of that page
   (also as a QR code). The page is the authority for the payment; the signature binds the deployment to its
   statement.
2. **Receipt page.** `site/proof/receipt.html` with `site/proof/receipt.mjs` and the verifier
   `site/proof/lib/receipt.mjs` (plain ES modules, no dependency, no build, same read-only RPC client and content
   security policy as the proof page). Addresses: `/receipt/<trade id>` on the hosted app, `receipt.html?trade=<id>`
   on the static proof site; optional `network`, `tx` and `signer`. The escrow contract and the audited code hash
   come only from `proof-manifest.json`; the release transaction from the link or, for journeys in the manifest,
   from the manifest. At one final block the page checks, and lists with expected and actual values:
   code hash equals the manifest; the trade is registered on that network; the inspection recorded on the contract
   is PASS and not invalidated; a release intent is PAID; its approval names this inspection and this evidence
   manifest; ledger conservation recomputed from `get_ledger` and the contract's own flag; the ledger's released
   total equals the paid intents; the transaction is a final, successful `execute_release` on the escrow naming this
   trade and intent with no failed receipt; and the escrow's only transfer in it moved exactly the intent's amount
   to the intent's destination and succeeded. Green only when every row passed; an unreadable value is an ERROR row
   and the verdict is red. A NEP-141 trade asset (M50, not merged) shows an ERROR row for the transfer check: token
   receipts are not checked by this build.
3. **Signed statement.** `GET /v1/trades/:id/payment-receipt` (buyer, supplier and members of their organisations;
   anyone else gets "not found") reads the contract afresh (trade, ledger, evidence, release) and the journal's
   RELEASE operation, and refuses with `INVALID_STATE` unless the contract shows a PAID intent whose operation is
   PAID with a recorded transaction (`RELEASE_NOT_PAID`, `RELEASE_TX_NOT_RECORDED`, `NO_INSPECTION`). The statement
   (`dockside/payment-receipt-statement@1`) holds trade, revision, terms digest, network, escrow, buyer and supplier
   (organisation and account), asset, amount, inspection (decision, reason codes, digest, time), release (intent,
   PAID, destination, paid time, transaction hash and signer), the verification address, the requesting principal,
   origin, key id, public key and signing time. Audited as `PAYMENT_RECEIPT_SIGNED`.
4. **Same key, own domain.** The statement is signed by the deployment's dedicated audit-export key in its isolated
   signer process (ADR-0018), whose allow-list gains `PAYMENT_RECEIPT` (DCE-1 domain `dockside/payment-receipt`).
   A receipt signature can never be read as an export signature or the reverse. Key enrollment, rotation,
   retirement and revocation are unchanged and apply to receipts: a revoked key signs no receipt and its receipts
   stop verifying.
5. **Deterministic PDF.** `services/api/src/receipt.ts` writes a one-page PDF 1.4 by hand (standard Type 1 fonts,
   no compression, no dependency): the receipt as text, the QR code of the verification address drawn as filled
   rectangles, the signature block, and the signed bundle as the attachment `dockside-receipt.json`. Every byte
   depends only on the bundle (the document date is the signing time). The QR encoder is `site/proof/lib/qr.mjs`,
   the same file the page uses; the hosted image therefore ships `site/proof`.
6. **Offline verification.** `verify-receipt <pdf> --trusted-keys <list>` (and `verifyReceiptPdf`) reads two files
   and checks: PDF header, attachment present, bundle schema and fields, statement fields, digest, Ed25519 signature,
   the key against the operator's published list (trusted, origin, not revoked, validity window, shared with
   `verify-export`), and finally renders the PDF again from the attached bundle and compares it byte for byte. Any
   edit of the visible text fails the last check even though the signature still holds. A PDF re-saved by another
   program fails too; the file must be kept as downloaded. The web app re-checks digest, signature, key and that the
   PDF carries exactly the signed statement before it offers the download.
7. **Hosted front.** `/proof/` serves the proof site and `/receipt/<trade id>` the receipt page with the site's files
   beside it, under a policy computed from the manifest (`connect-src 'self'` plus exactly its RPC origins, which
   must be HTTPS; otherwise the page's meta policy, plus `frame-ancestors 'none'`). Only files a browser loads are
   served (no type declarations); ids follow the page's own rule; paths cannot leave the proof site. The web app's
   policy is unchanged.
8. **Tests on recorded real data.** `scripts/proof/record-receipt-fixture.mjs` ran the real verifier against
   testnet once (read-only) and stored the answers in `fixtures/proof/testnet-receipt-recording.json`; the replay
   server gains two one-fact variants (`inspection-fail`, `release-unpaid`). The QR encoder is checked by decoding
   every symbol with an independent decoder (`jsqr` 1.4.0, Apache-2.0, published 2021-04-24, development
   dependency only) and against the standard's byte-capacity table.

## Consequences

- A paper receipt can be checked by anyone with a phone: the QR code opens the page, the page reads NEAR.
- The page cannot prove the off-chain documents or who held which key; it says so.
- The local stack's Vite preview server does not serve the proof site, so there the "Open the receipt page" link
  opens the app's "not found" screen; a simulated trade could not be verified anyway, because the page reads the
  public RPC endpoints of the manifest. On the hosted testnet runtime the link opens the receipt page.
- `verify-receipt` trusts the key list it is given; as for exports, that list must come out of band.

## Flip conditions

- When the NEP-141 rail (M50) is merged and a token trade is paid on testnet, add the `ft_transfer` receipt check
  and record it.
- Move the audit-export key to an HSM or KMS behind the same signer contract when one is provisioned (ADR-0018).
