# ADR-0029 — Attack console: a public "try to steal this payment" page

- Decision status: accepted (M53)
- Date: 2026-11-13, Dockside build stage M53
- Affected IDs: none of the sealed specification's test IDs. This decision goes **beyond the specification
  pack** (`docs/spec/`, unchanged): the pack has no public page that sends transactions on a visitor's
  behalf, and no account outside the trade's principals that signs anything. The contract is unchanged
  (code hash `7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`, the code on `gnanam1990-dock-escrow2.testnet`).

## Context

The proof page (ADR-0027) shows that completed journeys did what their records say. It cannot show what
the contract does when someone who should not move the money tries to. M47's refusal journey does that from
a command line, with the operator's own relayer. Judges and users should be able to try it themselves, on a
real trade, from a browser, and check the answer without trusting us.

## Decisions

1. **One demo trade, left in a held state on purpose.** `run-all --journey attack-demo` registers a trade,
   funds it (default suggestion 0.02 testnet NEAR), accepts the evidence and inspection, creates the
   release intent, records the buyer's approval, and then sets a deterministic-policy hold (28-day
   lifetime, inside the trade's 30-day expiry). It stops there. The whole amount stays reserved for the
   bound supplier, and the release is blocked. The approval comes before the hold so that a real accepted
   approval exists to replay.
2. **The attacker is a separate account with no authority.** The demo account is not a party, signer,
   destination or funder of the trade. It holds one function-call access key restricted to the escrow,
   with a gas allowance. A function-call key cannot attach a deposit and cannot call another contract,
   so it can only pay gas. The relay refuses a config whose attacker is a party or the escrow, and a key
   that is not the configured one. The key is checked on chain at start (`KeyFileTxSigner.verifyOnChain`:
   function-call, receiver the escrow).
3. **Five fixed attacks. Each one is the attacker's best honest attempt.** Every field the attacker can
   know is read from the chain and filled in correctly, so the refusal is about the one thing the attacker
   cannot have:

   | Attack | Call | What the attacker lacks | Code (first 24 h) |
   |---|---|---|---|
   | Change the payout account | `propose_destination_change`: the registered terms, revision + 1, predecessor digest, payout = attacker; signed as BUYER with a fresh key | the buyer's bound key | `SIGNATURE_INVALID` |
   | Release during a hold | `execute_release` of the live, approved intent | a clear hold | `HOLD_ACTIVE` (the message lists every blocker) |
   | Approve with the wrong key | `resolve_hold` RELEASE_HOLD: current header, hold id and reason, current manifest, fresh nonce; signed as RISK_RESOLVER with a fresh key | the risk resolver's bound key | `SIGNATURE_INVALID` |
   | Replay an approval | `approve_release` with the buyer's accepted approval, byte for byte | an unused approval | `INVALID_STATE` |
   | Refund to a stranger | `request_refund` EXCESS_FUNDING_RETURN naming the attacker as funder, initiated as FUNDER from the attacker's own account | a deposit of its own | `NOTHING_ELIGIBLE` |

   "Approve with the wrong key" signs the hold resolution, not a buyer approval: the buyer's approval is
   already recorded, so a second one is refused for the intent's state before any key is checked, which is
   what the replay shows. The hold resolution is the approval that stands between the trade and its
   release, and it reaches the signature check.

   A fresh Ed25519 key is generated for each signed attempt and discarded; it is bound to nothing. The
   replay's bytes come from the demo config and are checked against the approval digest the chain
   recorded (and, when the config is built, against the approval transaction's own arguments).
4. **The relay decides nothing about the payload a visitor sends.** A request names one of the five attack
   ids; nothing else in it reaches the chain. Before building, the relay reads the trade and refuses to
   send unless the demo is *armed*: the demo intent is live, nothing is paid, the intent and the active
   revision pay the bound supplier, and an unresolved hold blocks the release. If the contract ever
   accepts an attempt, or the trade's ledger totals differ after one, the relay stops for good
   (`ACCEPTED`) until restarted by its operator. Limits: one transaction at a time, one attempt per client
   every 20 seconds, 30 attempts per 10 minutes over all clients, and on chain the key's allowance.
5. **The page trusts the chain, not the relay.** The relay returns a transaction hash. The page reads that
   transaction from the public RPC endpoint and shows the code from the escrow receipt itself; a relay that
   reports another code is flagged. The page also reads the trade's ledger, release state and holds, and
   the demo key's access-key nonce: attempts = nonce − the nonce recorded when the demo was set up.
6. **It works without the relay.** The page lives at `site/proof/attack/` and is published with the proof
   page. On GitHub Pages it first probes a same-origin relay (absent there), then the configured hosted
   relay (CORS only for the configured origins), and otherwise replays the attempts recorded in
   `attack-demo.json` by reading those transactions from the chain. The hosted app serves the proof site
   under `/proof/`, the console at `/proof/attack/` (`/attack` redirects), and forwards
   `/proof/attack/api/*` to the relay process on loopback.
7. **The relay is its own process with its own key.** The hosted launcher starts `attack/main.js` with an
   environment that contains only its port, config path, log path, allowed origins, RPC URL and the path of
   the demo key file. The entrypoint prepares that file from `ATTACK_KEY_JSON_B64` or
   `/etc/secrets/attack-key.json` the same way as the relayer key, and removes the variable. The API and
   the worker never see the demo key; the relay never sees the relayer key. Without a live config or a
   usable key the relay answers `RELAY_OFF` and the container keeps running.

## Consequences

- Codes depend on time. The approval and the manifest attestation are signed for 24 hours by the journey's
  payload builder. Afterwards the replay is refused as `EXPIRED`, the release lists
  `MANIFEST_NOT_CURRENT` first (with `HOLD_ACTIVE` still among the blockers), and the other three keep their
  codes. Every attempt is still refused (tested on the core 25 hours later). The page shows the code the
  contract returned and says what was expected in the first 24 hours.
- The demo trade's amount stays locked in the escrow. The operator can still finish or refund it with the
  trade's own keys (the run's seed): resolve the hold, approve again, and release to the supplier.
- The relay spends testnet gas from the allowance only. The allowance and the rate limits bound the cost.
- Not shown: who held which key (INV-13); the demo's principal keys all derive from one operator's test
  run, as in the other run-all journeys.
