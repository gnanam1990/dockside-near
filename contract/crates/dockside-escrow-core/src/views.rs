//! Read-only JSON projections of authoritative contract state. Amounts are decimal strings.

use crate::assets::UnexpectedAsset;
use crate::ledger::FunderLedger;
use crate::trade::TradeRecord;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde_json::{json, Map, Value as J};

fn s(x: u128) -> J {
    J::String(x.to_string())
}

pub fn funder(f: &FunderLedger) -> J {
    json!({
        "funded": s(f.funded), "partial": s(f.partial), "available": s(f.available),
        "reserved": s(f.reserved), "released": s(f.released), "refundLocked": s(f.refund_locked),
        "refunded": s(f.refunded), "quarantined": s(f.quarantined), "fees": s(f.fees),
        "excessDetectedAt": f.excess_detected_at,
    })
}

pub fn ledger(t: &TradeRecord) -> J {
    let mut funders = Map::new();
    let mut tot = FunderLedger::default();
    for (k, f) in &t.ledger.funders {
        funders.insert(k.clone(), funder(f));
        tot.funded += f.funded;
        tot.partial += f.partial;
        tot.available += f.available;
        tot.reserved += f.reserved;
        tot.released += f.released;
        tot.refund_locked += f.refund_locked;
        tot.refunded += f.refunded;
        tot.quarantined += f.quarantined;
        tot.fees += f.fees;
    }
    let deposits: Vec<J> = t
        .ledger
        .deposits
        .iter()
        .map(|d| json!({"index": d.index, "funder": d.funder, "amount": s(d.amount), "accepted": s(d.accepted), "quarantined": s(d.quarantined), "atMs": d.at_ms}))
        .collect();
    json!({
        "asset": {"kind": "NEAR_NATIVE", "network": t.terms.network},
        "required": s(t.ledger.required),
        "committed": s(t.ledger.committed()),
        "fullyFunded": t.ledger.fully_funded(),
        "totals": funder(&tot),
        "funders": J::Object(funders),
        "deposits": deposits,
        "conservation": t.ledger.check_conservation().is_ok(),
    })
}

pub fn refunds(t: &TradeRecord) -> J {
    J::Array(
        t.refunds
            .values()
            .map(|r| {
                json!({
                    "refundIntentId": r.id, "reason": r.reason, "funder": r.funder, "amount": s(r.amount),
                    "sourceBucket": r.source_bucket.as_str(), "state": r.state.as_str(),
                    "requestDigest": r.request_digest, "initiatorRole": r.initiator_role,
                    "buyerSigned": r.buyer_signed, "supplierSigned": r.supplier_signed,
                    "clockOrigin": r.clock_origin, "deadline": r.deadline, "requestedAt": r.requested_at,
                    "dispute": r.dispute.as_ref().map(|d| json!({"role": d.role, "at": d.at, "digest": d.digest})),
                    "history": r.history.iter().map(|(st, at)| json!([st, at])).collect::<Vec<J>>(),
                })
            })
            .collect(),
    )
}

pub fn holds(t: &TradeRecord, now_ms: u64) -> J {
    J::Array(
        t.holds
            .values()
            .map(|h| {
                json!({
                    "holdId": h.id, "status": h.status(now_ms), "reasonCode": h.reason_code, "issuerRole": h.issuer_role,
                    "ruleId": h.rule_id, "manifestDigest": h.manifest_digest, "issuedAt": h.issued_at,
                    "expiresAt": h.expires_at, "recordedAt": h.recorded_at, "setDigest": h.set_digest,
                    "resolution": h.resolution.as_ref().map(|r| json!({"code": r.code, "evidenceDigest": r.evidence_digest, "resolvedAt": r.resolved_at, "digest": r.digest})),
                })
            })
            .collect(),
    )
}

pub fn trade(t: &TradeRecord, now_ms: u64) -> J {
    json!({
        "tradeId": t.terms.trade_id,
        "revision": t.terms.revision,
        "termsDigest": t.terms_digest,
        "network": t.terms.network,
        "buyerAccount": t.terms.buyer.account_id,
        "supplierAccount": t.terms.supplier.account_id,
        "payoutDestination": t.terms.payout_destination,
        "amountYocto": s(t.terms.amount_yocto),
        "expiresAt": t.terms.expires_at,
        "registeredAt": t.registered_at,
        "revokedRoles": t.revoked_roles.iter().cloned().collect::<Vec<String>>(),
        "blockingHolds": t.blocking_holds(),
        "currentManifestDigest": t.current_manifest_digest(now_ms),
        "ledger": ledger(t),
    })
}

pub fn unexpected(a: &UnexpectedAsset) -> J {
    json!({
        "index": a.index, "standard": a.standard, "assetContract": a.asset_contract, "tokenId": a.token_id,
        "observedAmount": a.observed_amount, "claimedSender": a.claimed_sender, "msgDigest": a.msg_digest,
        "observedAt": a.observed_at, "state": a.state, "originalFunder": J::Null, "withdrawable": false,
    })
}

pub fn evidence(t: &TradeRecord, now_ms: u64) -> J {
    let e = &t.evidence;
    let manifest = |m: &crate::evidence::ManifestRecord| {
        json!({
            "revision": m.revision, "digest": m.digest, "attestationDigest": m.attestation_digest,
            "acceptedAt": m.accepted_at, "expiresAt": m.expires_at, "minFreshUntil": m.min_fresh_until,
            "items": m.items, "status": format!("{:?}", m.status).to_uppercase(), "consumed": m.consumed,
        })
    };
    json!({
        "policy": e.policy.as_ref().map(|p| json!({
            "policyId": p.policy_id, "revision": p.revision, "digest": p.digest,
            "attestationLifetimeMs": p.attestation_lifetime_ms,
            "slots": p.slots.iter().map(|s| json!({"slotId": s.slot_id, "digest": s.digest, "minItems": s.min_items, "maxItems": s.max_items})).collect::<Vec<J>>(),
        })),
        "current": e.current.as_ref().map(manifest),
        "usable": e.usable(now_ms).is_some(),
        "history": e.history.iter().map(manifest).collect::<Vec<J>>(),
        "inspection": e.inspection.as_ref().map(|i| json!({
            "decision": i.decision, "reasonCodes": i.reason_codes, "manifestDigest": i.manifest_digest,
            "manifestRevision": i.manifest_revision, "digest": i.digest, "recordedAt": i.recorded_at,
            "expiresAt": i.expires_at, "invalidated": i.invalidated,
        })),
        "currentInspectionDecision": e.current_inspection(now_ms).map(|i| i.decision.clone()),
    })
}
