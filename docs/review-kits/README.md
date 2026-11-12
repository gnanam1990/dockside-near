# Reviewer kits

Three self-contained briefings for people other than the project owner. Each one says who takes part, what they
do, what they record and how a result is judged, and ends with a form to fill in. None of them changes the
specification in [`docs/spec/`](../spec/); where a kit and the specification disagree, the specification wins.

| Kit | For | Closes (when it passes) | Gate item |
|---|---|---|---|
| [inv13-acceptance.md](inv13-acceptance.md) | Six or more separate people on separate devices, plus a coordinator | INV-13 human acceptance; the testnet halves of T-005 and T-036 | REAL-PRODUCT-GATE item 3 |
| [accessibility-review.md](accessibility-review.md) | One or two accessibility reviewers with NVDA and VoiceOver | Manual parts of T-039 and T-040 | REAL-PRODUCT-GATE item 13 |
| [security-review.md](security-review.md) | An independent security reviewer | A reviewed answer to every SECURITY.md control | SECURITY.md "Security review must test actual contract, service, packaged worker, and deployed headers" |

Common rules for every kit:

- Review **one exact build**: record the commit SHA and, where a deployment is involved, the escrow account and
  the on-chain code hash. A result for a different commit does not count.
- Never paste keys, seed phrases, session tokens, invitation secrets or custody locators into a form, an issue,
  a chat or a screenshot. Every form here asks only for public identifiers.
- A kit result is evidence for [BUILD-STATUS.md](../../BUILD-STATUS.md); the owner copies it there item by item.
  A filled form is not a `PASS` until the owner has checked it against the same build.
- The current status of everything these kits touch is in the REAL-PRODUCT-GATE matrix of
  [BUILD-STATUS.md](../../BUILD-STATUS.md) and in [USER-NEXT-STEPS.md](../USER-NEXT-STEPS.md).
