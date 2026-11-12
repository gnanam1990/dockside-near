# INV-13 acceptance: separate people on separate devices

A script for running Dockside's independent-party acceptance with real people. It is written for the people who
take part, not for the project owner, and needs no knowledge of the code.

## 1. What this proves and why it needs you

INV-13 ([CORE-CONTRACT.md](../spec/CORE-CONTRACT.md)) says buyer, supplier, inspector and risk/policy authority
must be established through **separate enrolled identities and proof-of-possession sessions**, and that one
operator holding every key cannot satisfy product acceptance. Every automated test of this build is driven by one
operator, so this part of the gate can only be produced by separate people. A successful run closes:

| Item | What this run adds |
|---|---|
| REAL-PRODUCT-GATE item 3 | the agreement and authority flow completed by independently enrolled principals in separate sessions |
| T-005 (testnet half) | invitations accepted by the recipient in their own session, granted later by a different administrator |
| T-036 (testnet half, the human part) | a fresh user completes the product workflow with separate buyer, supplier, inspector and risk/policy sessions |
| T-054 (testnet half) | only the risk/policy person sees and signs hold resolution |

It does **not** cover the technical testnet checks (deployment, refund reasons, process kills); those are in
[USER-NEXT-STEPS.md](../USER-NEXT-STEPS.md) §3 and §7 and may be run by the owner alone.

## 2. Before the day (owner and coordinator)

1. **One exact build, deployed.** The owner deploys one commit to NEAR testnet and runs the API and web app over
   HTTPS as described in [USER-NEXT-STEPS.md](../USER-NEXT-STEPS.md) §1–§5. Write down, on the result form (§9):
   the commit SHA, the web origin, the escrow account, the on-chain code hash and the `/readyz` output
   (`network: near-testnet`, `fundedPayouts: BLOCKED`).
2. **Services run elsewhere.** The ManifestAttestor and deterministic-policy services run as their own
   processes with their own keys, not inside the API process, ideally on another host (USER-NEXT-STEPS §5).
   Their operator is not one of the six people below.
3. **Relayer.** The relayer `TxSigner` is provisioned (USER-NEXT-STEPS §4) so relay calls the web app prepares
   are submitted. Funding is signed by the buyer's own NEAR account.
4. **A rehearsal is allowed, but does not count.** The [local stack](../../scripts/local-stack/README.md) runs the
   same web app over a simulated chain. Use it to practise; mark any such run "rehearsal, simulated chain" on the
   form. Only a run against the testnet deployment of the recorded build can pass this kit.
5. **A side channel.** Agree one private channel per pair (for example a direct message between two people) for
   handing over invitation secrets, the proposal package and NEAR account names. The coordinator is **not** on
   these channels and never sees a secret.
6. **Device labels.** The coordinator gives every device a label (`D1` … `D6`) before the day.

## 3. People and roles

Each row is a **different person** using **their own device** (a laptop or desktop they normally use, not a
shared machine, not a virtual machine or browser profile on someone else's computer, not a remote desktop into
another participant's machine). One person, one device, one browser profile for the whole run.

| Label | Person | Organization | Capability granted in the app | Device |
|---|---|---|---|---|
| A1 | Buyer security administrator | Buyer org | `ORG_SECURITY_ADMIN` (from bootstrap) | D1 |
| A2 | Supplier security administrator | Supplier org | `ORG_SECURITY_ADMIN` (from bootstrap) | D2 |
| P1 | Buyer approver | Buyer org | `BUYER_APPROVER` | D3 |
| P2 | Supplier signer | Supplier org | `SUPPLIER_SIGNER` | D4 |
| P3 | Inspector | Buyer org | `INSPECTOR` | D5 |
| P4 | Risk/policy resolver | Buyer org | `RISK_RESOLVER` | D6 |
| C | Coordinator and recorder | none | none: holds no key and never signs in | own device |
| S | Service operator (owner's side) | Buyer org services | `MANIFEST_ATTEST`, `DETERMINISTIC_POLICY_SET` through service enrollment | service host |

The four party people (P1–P4) must not be the same humans as A1, A2, C or S. If the organizations need an
auditor, add one more person with `AUDITOR` on their own device; it is optional for this kit.

Each person needs a current desktop browser (Firefox, Chrome, Edge or Safari) with a regular profile: the app
keeps a non-extractable device key in the browser's storage, so private windows, "clear on exit" settings and
locked-down kiosk profiles will not work. P1 and P2 also need a NEAR testnet account they control; P1's account
funds the trade (USER-NEXT-STEPS §2).

## 4. Ground rules during the run

- Nobody touches another person's device, reads out a secret on a shared call, or shares a screen while a secret
  or signature review is visible.
- Invitation secrets and the proposal package travel only on the private pair channel from §2.5.
- Nobody exports, copies or imports a device key. If a key is lost, stop and use the recovery flow; never
  "borrow" another key.
- The coordinator calls each step, the named person performs it and reads back the result; the coordinator
  writes it down. A step done by anyone other than the named person is a **fail** for that step, even if it
  worked.
- Times are written in UTC. Use the app's own UTC timestamps where it shows them.
- Screenshots are optional. If you take one, check first that no secret, invitation panel or private evidence is
  on screen.

## 5. Phase A: organizations and invitations

| Step | Who (device) | What they do in the web app | What to record |
|---|---|---|---|
| A-1 | A1 (D1) | Open the web origin, go to **Sign in → Create an organization**, enter the buyer organization name, press **Request bootstrap challenge**, review and sign with the new device key | buyer org ID, A1 principal ID (shown under **Organization → Your principal and session**), A1 public key prefix (first 12 characters, **Organization → Device keys in this browser**) |
| A-2 | A2 (D2) | Same as A-1 for the supplier organization | supplier org ID, A2 principal ID, key prefix |
| A-3 | A1 (D1) | **Organization → Invite a principal**: create three invitations, one each for **Buyer approver**, **Inspector** and **Risk resolver**. Each one-time secret is shown once; send it to the right person on the private channel | the three invitation IDs and expiries (not the secrets) |
| A-4 | A2 (D2) | Create one invitation for **Supplier signer** and send it to P2 privately | invitation ID and expiry |
| A-5 | P1 (D3), P2 (D4), P3 (D5), P4 (D6), each on their own device | **Sign in → Accept an invitation**: paste the secret, optional display name, **Request invitation challenge**, review, sign with the device key the browser creates | each person's principal ID and key prefix |
| A-6 | A1 (D1) | **Organization → Grant an accepted invitation**: enter each of the three invitation IDs, **Review grant**, **Grant capability** | the grant time and principal ID per capability |
| A-7 | A2 (D2) | Grant the supplier-signer invitation the same way | grant time, principal ID |
| A-8 | P1–P4 | Sign out and back in with **Sign in with a stored device key**; open **Organization → Your principal and session** and read out the capability shown | the capability each person sees; it must be exactly the one granted |
| A-9 | S with A1 (D1) | The service operator answers the custody challenge for the ManifestAttestor and deterministic-policy services; A1 enrolls and activates them under **Organization → Service identities** | both enrollment IDs, key versions, custody kind (never the locator) |
| A-10 | A1 (D1) | Under **Organization → Policies** check the evidence policy the trade will use is active | EvidencePolicy ID and revision |
| A-11 | P1 (D3), P2 (D4) | Optional but recommended: **Organization → NEAR accounts**, link your own testnet account with your wallet (NEP-413 signature, then the full-access key check) | linked account name, result |

## 6. Phase B: independence checks (each must be refused)

Run these right after Phase A. Each is a deliberate wrong action; the expected outcome is a visible refusal and
no change. Record the exact message or error code the app shows.

| Check | Who (device) | Attempt | Expected |
|---|---|---|---|
| N-1 | A1 (D1) | Create one more **Buyer approver** invitation, then, still signed in as A1, try to accept it on **Accept an invitation** in the same browser | refused: an invitation cannot be accepted from inside an existing session or with an enrolled key |
| N-2 | P3 (D5) | Paste the secret from N-1 (sent privately by A1) and accept it; then A1 tries to grant it | the grant is refused with `SEPARATION_OF_DUTIES`: a principal may hold only one party capability. P3 keeps only `INSPECTOR` |
| N-3 | P4 (D6) | Accept the N-1 secret a second time (after P3 used it) | refused: the invitation is one-time and already consumed |
| N-4 | A2 (D2) | Enter one of the buyer organization's invitation IDs from A-3 under **Grant an accepted invitation** | refused: the invitation belongs to another organization |
| N-5 | P1 (D3) | Look for a way to sign an inspection, sign a hold resolution, or upload as the inspector | the controls are absent or disabled with a reason; nothing is signed |
| N-6 | P2 (D4) | Look for **Approve release** or **Execute direct release** on any trade | absent or disabled with a reason |

A1 revokes the stray invitation or grant from N-1/N-2 if one was created, and records that it did.

## 7. Phase C: the trade, each step by its own person

The trade amount is small testnet NEAR agreed beforehand. Every signature preview shows a digest, an actor and a
consequence: the signer reads the actor line aloud before signing, and the coordinator records whether it named
the signer's own principal.

| Step | Who (device) | What they do | What to record |
|---|---|---|---|
| C-1 | P1 (D3) | **Trades → Create trade**: fill the five steps (parties and keys, asset and amount, supplier destination = P2's testnet account, inspector P3 and risk/policy P4 with the enrolled services and evidence policy, review). **Request canonical agreement**, **Sign as buyer approver**. Send the proposal package to P2 privately | trade reference, agreement digest (first 12 characters) |
| C-2 | P2 (D4) | **Trades → Countersign a proposal**: paste the package, **Review proposal**, confirm the destination is P2's own account, **Sign as supplier signer and submit**; then **Submit to the escrow contract** for the register calls if the page offers it | trade ID, register transaction hashes |
| C-3 | P1 (D3) | Fund the exact amount from P1's own testnet account with the call shown under **Overview → How funding happens** | funding transaction hash; the funded amount on the Overview tab |
| C-4 | P2 (D4) and P3 (D5) | **Evidence** tab: each uploads the slots assigned to them (for example the commercial invoice by P2, the inspection report by P3). Wait for the ManifestAttestor attestation to appear | slot names filled, by whom, manifest revision and digest prefix |
| C-5 | P3 (D5) | **Evidence → Inspector**: **Prepare inspection**, choose `PASS`, **Sign inspection** | inspection digest prefix, time |
| C-6 | S | The deterministic-policy service SETs a hold on the trade | hold ID, issuer shown as deterministic policy |
| C-7 | P1 (D3) | Confirm **Release** shows the hold as a blocker. On the hold, **Request resolution** with a short message | the blocker text; that the request is labelled as non-authorizing |
| C-8 | P1, P2, P3 | Each confirms that **Prepare resolution** is absent in their session | yes/no per person |
| C-9 | P4 (D6) | Open the trade, **Prepare resolution**, check the exact resolution preview, **Sign resolution** | resolution digest prefix, time; the hold shows resolved |
| C-10 | P1 (D3) | **Release**: **Prepare release intent**, **Sign release intent** | releaseIntentId, locked amount |
| C-11 | P1 (D3) and P2 (D4) | Cancellation check: P1 starts **Request cancellation**; P2 alone signs first and P1 does not: the intent must stay locked. Then **both** sign their consent with **Sign my consent** and the intent is cancelled. P1 creates a new intent (repeat C-10) | that one signature left the lock in place; that two matching signatures cancelled it; the new releaseIntentId |
| C-12 | P1 (D3) | **Prepare approval**, review amount, asset, recipient and network, **Sign approval**, then **Execute direct release → Queue release** | approval digest prefix, release transaction hash |
| C-13 | all | Wait for **Payout** to show `PAID` with the destination receipt. P2 checks the amount arrived at P2's own testnet account in P2's own wallet or explorer | PAID time, receipt, P2's observed balance change |
| C-14 | P1 (D3) | **Timeline**: **Prepare signed export**, **Save signed export**, send the bundle to C. C (or the owner) runs `pnpm run verify-export <bundle.json> --trusted-keys <keys.json>` with the key list obtained out of band | verify exit code (must be 0), bundle checksum |

## 8. Pass and fail

The run **passes** only if every one of these holds:

1. Every step in §5 and §7 was performed by the named person on their own labelled device, and each reported
   the result in their own session.
2. Every check in §6 was refused, and nothing in the app changed because of it.
3. The four party principals (P1–P4) have four different principal IDs, four different public keys, and were
   each enrolled through their own invitation in their own session; buyer and supplier belong to different
   organizations. The signed audit export lists them that way.
4. Each signature preview named the person signing it (C-1, C-2, C-5, C-9, C-10, C-11, C-12).
5. The hold blocked release until P4 alone resolved it; nobody else saw a resolution control.
6. The trade reached `PAID` with the exact amount at P2's own account, and the export verified with exit code 0.
7. No database edit, operator intervention, shared key, borrowed device or copied session was needed at any
   point.

The run **fails** if any of these is false. Record which step failed and stop or continue as the coordinator
decides; a failed run is still useful evidence, and the form should be kept.

A run that passed on the local stack is recorded as a rehearsal and does not count.

## 9. Result form

Copy this block into a new file (for example `docs/evidence/inv13-<date>.md`) and fill it in. Use public
identifiers and prefixes only.

```text
INV-13 acceptance result
Run type:            [ ] testnet deployment   [ ] rehearsal (simulated chain, does not count)
Date (UTC):
Coordinator:
Commit SHA:
Web origin:
Escrow account:
On-chain code hash:
/readyz network and fundedPayouts:

People and devices
| Label | Name or pseudonym | Device | OS and browser with version | Principal ID | Key prefix | Capability seen (A-8) |
|-------|-------------------|--------|-----------------------------|--------------|------------|-----------------------|
| A1    |                   | D1     |                             |              |            | ORG_SECURITY_ADMIN    |
| A2    |                   | D2     |                             |              |            | ORG_SECURITY_ADMIN    |
| P1    |                   | D3     |                             |              |            |                       |
| P2    |                   | D4     |                             |              |            |                       |
| P3    |                   | D5     |                             |              |            |                       |
| P4    |                   | D6     |                             |              |            |                       |

Services: ManifestAttestor enrollment ID / key version:          Deterministic-policy enrollment ID / key version:
Custody kind for each (never the locator):

Steps
| Step | Done by (label) | Time (UTC) | Result (as shown) | Identifiers recorded | OK? |
|------|-----------------|------------|-------------------|----------------------|-----|
| A-1  |                 |            |                   |                      |     |
| ...  |                 |            |                   |                      |     |
| N-1  |                 |            | refusal text:     |                      |     |
| ...  |                 |            |                   |                      |     |
| C-1  |                 |            |                   |                      |     |
| ...  |                 |            |                   |                      |     |
| C-14 |                 |            | verify exit code: |                      |     |

Transactions: register, fund, release (hashes):
Trade ID:                    releaseIntentId (final):
Signed export checksum:      verify-export exit code:

Pass criteria (section 8)
1 [ ]  2 [ ]  3 [ ]  4 [ ]  5 [ ]  6 [ ]  7 [ ]
Overall: [ ] PASS  [ ] FAIL     Failed steps:
Problems seen (any confusing screen, wording, or step that needed help):

Signatures of the participants confirming they used only their own device and key:
A1:        A2:        P1:        P2:        P3:        P4:        C:
```

When the owner has checked the form against the same build, the result goes into the REAL-PRODUCT-GATE matrix
of [BUILD-STATUS.md](../../BUILD-STATUS.md) (item 3) and the T-005, T-036 and T-054 rows.
