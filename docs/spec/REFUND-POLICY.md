# Dockside Refund and Recovery Policy

Policy ID: `dockside-refund-v1`  
Policy revision: `1`  
Status: **SPECIFICATION_ONLY**  
Runtime evidence: **NOT_RUN**

This file is authoritative for the first native-NEAR testnet corridor. A trade revision signs the policy ID and revision. Changing a row creates a new policy revision and cannot alter an active trade in place.

## Common rules

- Refund applies only to accepted native testnet NEAR deposits and tracks each deposit's original funder.
- Eligible amount is the named deposit slice minus already released, refunded, fee-consumed or economically locked value.
- Every refund request has stable `refundIntentId`, trade/revision, policy ID/revision, reason, original funder, eligible amount, exact `sourceBucket`, clock origin, deadline, required evidence/signatures and nonce.
- Before submit, allowed revocation atomically cancels the refund intent and restores the same funder slice to its recorded `sourceBucket`. `EXCESS_FUNDING_RETURN` always returns to `QUARANTINED`; partial and ordinary eligible deposits return to their recorded pre-intent bucket, never a generic available/reserved choice.
- At `EXECUTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION`, refund value remains locked; no second refund, release intent, destination activation, cancellation, abandonment or supersession can consume it.
- Refund progression is authoritative and monotonic except for explicitly allowed pre-execution revocation:

```text
NONE -> REQUESTED -> TIMELOCKED -> AUTHORIZED -> EXECUTING
EXECUTING -> PROCESSING | UNKNOWN | REFUNDED | FAILED | REVIEW
UNKNOWN -> PROCESSING | REFUNDED | FAILED | REVIEW | RECONCILING
PROCESSING -> REFUNDED | FAILED | REVIEW
REVIEW -> RECONCILING | ADJUDICATION
RECONCILING -> PROCESSING | REFUNDED | FAILED | REVIEW
ADJUDICATION -> RECONCILING | REVIEW
```

- A submitted refund with missing response becomes `UNKNOWN` and reconciles from the original transaction identity; never blind retry. Every outgoing state above requires authoritative evidence and preserves the original operation identity.
- `FAILED` is permitted only after authoritative non-transfer and escrow-accounting proof, restores the exact source bucket, and requires a new refundIntentId plus fresh current authorization for another attempt. A late original-funder receipt resolves the original intent to `REFUNDED`; contradictory evidence stays locked in `REVIEW`.
- Refund terminal evidence is the NEAR contract transaction and original-funder account receipt. Failure does not automatically unlock value until authoritative reconciliation.
- Provider refund in a future mainnet rail is not one of these direct escrow reasons. It returns to quote-bound escrow/refund authority and is then reconciled to the original funder ledger.

## Authoritative reason matrix

| Reason | Initiator | Required signers/authority | Clock origin and duration | Required evidence | Challenge or appeal | Eligible amount and recipient | Revocation and UNKNOWN |
|---|---|---|---|---|---|---|---|
| `TRADE_EXPIRY` | designated buyer approver or supplier signer | no fresh dual consent beyond both parties' signed trade/policy; the designated initiator signs the request | signed `tradeExpiresAt`; 24-hour challenge | current contract time, no submitted/unresolved release intent, funder ledger | either buyer or supplier opens dispute before deadline; refund pauses in REVIEW | unreleased, unlocked accepted deposits, each to its original funder | initiator may revoke before authorization if no dispute; submit ambiguity stays UNKNOWN |
| `INSPECTION_FAIL` | designated buyer approver or supplier signer | current independent inspector FAIL attestation; separate risk/policy signer authorizes after window | attestation recorded time; 48-hour challenge | current complete manifest, valid FAIL signature, no superseding inspection | supplier may appeal with evidence before deadline; risk/policy principal may resolve to retry inspection or refund | current milestone's unreleased, unlocked funder slices to original funders | risk/policy principal may revoke before execution; submitted ambiguity stays UNKNOWN |
| `PERMANENT_HOLD` | enrolled separate risk/policy principal | risk/policy resolver signs `RESOLVE_TO_REFUND`; supplier signer consents | second required signature time; 48-hour cooling period | current HoldRecord, signed resolution reason/evidence, no later hold resolution | either required party may revoke during cooling; disagreement remains DISPUTED | unreleased, unlocked funder slices to original funders | either signer may revoke before authorization; submitted ambiguity stays UNKNOWN |
| `MUTUAL_CANCEL` | buyer or supplier | buyer and supplier sign identical cancellation digest | second signature time; 1-hour revocation period | current revision, exact eligible ledger, no submitted or otherwise unresolved release intent | either signer may revoke before deadline; then cancellation is void | all unreleased, unlocked accepted deposits to their original funders | either signer revokes before authorization; submitted ambiguity stays UNKNOWN |
| `BUYER_KEY_LOSS` | buyer organization recovery admin | configured two-of-N buyer recovery principals | second recovery signature; 72-hour recovery delay | proof-of-possession failure record, affected key version, notifications | supplier may flag dispute; risk principal may extend/pause | no automatic refund; amount remains locked until key recovery then another policy reason is used | recovery can be cancelled before activation; no refund submit exists |
| `SUPPLIER_KEY_LOSS` | supplier recovery principal | supplier recovery policy plus buyer consent for active trade revision | final required signature; 72-hour recovery delay | affected key, new proof of possession, destination unchanged or new destination revision | buyer can reject; unresolved case remains REVIEW | no automatic refund; use mutual cancel or another eligible reason if parties choose | recovery cancellation preserves current trade; no refund submit exists |
| `INSPECTOR_KEY_LOSS` | buyer or supplier | buyer and supplier appoint a new independent inspector | second appointment signature; 24-hour delay | affected inspector key, new inspector proof of possession | either party may reject; unresolved case remains REVIEW | no automatic refund; prior attestation invalid and new inspection required | appointment may be revoked before activation; no refund submit exists |
| `PARTIAL_FUNDING_RETURN` | original funder | original funder signs refund request | request time; 1-hour cooling period | trade still below required amount, no release intent, exact funder slice | buyer or supplier may dispute accounting only; cannot redirect recipient | that funder's accepted partial amount to the same original funder | funder may revoke before execution; submit ambiguity stays UNKNOWN |
| `EXCESS_FUNDING_RETURN` | original funder | original funder signs refund request | excess detection time; 1-hour cooling period | exact accepted excess beyond trade requirement, no economic lock | buyer/risk may dispute amount; recipient cannot change | only that funder's quarantined excess to the same original funder | funder may revoke before execution and the slice returns to `QUARANTINED`; submit ambiguity stays locked in UNKNOWN |

## Unexpected assets

Unexpected token or asset transfers are not native-NEAR funding and never enter the refund state machine or native-NEAR conservation equation. They use this separate recovery policy:

| Recovery reason | Initiator | Required signers/authority | Clock origin and duration | Required evidence | Challenge or appeal | Eligible amount and recipient | Revocation and UNKNOWN |
|---|---|---|---|---|---|---|---|
| `UNEXPECTED_ASSET_RECOVERY` | claimed sender | claimed sender proof-of-control plus enrolled risk/policy approval and an asset-specific contract recovery capability | final required authorization time; 72-hour challenge, then only when the asset adapter is safe | chain, token contract, transaction/log, exact observed balance, sender and recipient proof, transfer capability and simulation/read-only validation | buyer, supplier, another claimant or risk principal may challenge; unresolved ownership/capability stays `ASSET_RECOVERY_REVIEW` or `UNRECOVERABLE_OR_REVIEW` | at most the exact separately observed unexpected-asset balance; only to the independently proven sender destination, never a native-NEAR original-funder field | claimed sender or risk principal may revoke before execution; after submit the exact asset is locked, ambiguity is `UNKNOWN`, and reconciliation uses the original asset transaction identity without blind retry |

The asset cannot be swept to buyer, supplier, executor or administrator by a generic refund action. A missing safe contract capability never becomes a manually asserted success.

## Contract enforcement

The contract validates policy ID/revision, reason, clock, signatures/capabilities, evidence commitments, eligible amount, original-funder recipient, source bucket and economic locks. API projections or caller-provided `eligible=true` have no authority. Release and refund transitions are serialized atomically. Destination activation may supersede only a pre-submit release intent and cannot bypass any unresolved refund intent. Manual reconciliation/adjudication cannot force a terminal outcome or change a source bucket.
