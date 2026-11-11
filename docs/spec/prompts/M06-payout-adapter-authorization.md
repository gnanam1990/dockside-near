# M06 — 1Click adapter and funded authorization

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Optional module; dependency: M05. It is not a dependency of `WORKING_TESTNET`, M07, M08, or M09.

Mapped IDs: FR-07, FR-16, NFR-02, NFR-07, INV-03, INV-05, INV-06, INV-07, INV-09, INV-14, T-024, T-025, T-026, T-027, T-048, T-055.

If this optional module is selected, pin the official client and implement the independent dry compatibility state `NOT_RUN | UNKNOWN | INCOMPATIBLE | PASS` for the future bound recipient. Only `PASS` permits `DRY_COMPATIBLE`; none can affect release-intent state, direct testnet release, escrow value, `WORKING_TESTNET`, funded status or payment. Implement the blocked mainnet design only behind configuration: post-quote FundedPayoutAuthorization binds release intent, quote/digest, deposit address, final recipient, networks/assets, amounts/min output, fees/slippage/cap, refundTo escrow authority, nonce, expiry and signer. Contract consumes it atomically once before transfer to deposit address.

Start with every field mutation, stale quote, wrong refundTo, duplicate consume, secret egress, dry-to-paid escalation and stale-projection/direct-worker attempts under active or expired-unresolved holds. The optional executor cannot bypass the contract hold predicate. Funded calls remain blocked without explicit authorization and verified corridor; do not substitute a mock success.
