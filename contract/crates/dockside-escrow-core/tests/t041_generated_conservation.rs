//! T-041: conservation survives generated sequences (INV-02, INV-12, NFR-01).
//!
//! A seeded generator drives the real contract core through random interleavings of funding
//! (under, exact and excess, several funders), evidence acceptance, holds, release intents,
//! approvals, execution with transferred and returned outcomes, dual-signed CANCEL, every native
//! refund row that a funder or party can start (partial, excess, mutual cancel, trade expiry),
//! authorization, execution with transferred and returned outcomes, revocation and the passage
//! of time. Every payload is signed with the bound keys; nothing is assigned on the record.
//!
//! A rejected call is rolled back to the state before it, as the NEAR runtime does for a
//! panicking call. After every step an independent shadow ledger kept by the test (what each
//! funder sent in, what left to the supplier, what left to each funder) must agree with the
//! contract ledger, and the source-bucket rules must hold: reserved value equals the live
//! intent's slices, refund-locked value equals the live refund rows per funder, released value
//! never exceeds the trade amount and excess never becomes releasable.

mod common;
use common::evidence::*;
use common::release::*;
use common::*;
use dockside_escrow_core::ledger::Bucket;
use dockside_escrow_core::refund::{RefundSignatures, RefundState};
use dockside_escrow_core::release::IntentState;
use dockside_escrow_core::TradeRecord;
use std::collections::BTreeMap;

const THIRD_FUNDER: &str = "port-treasury.testnet";
const FUNDERS: [&str; 3] = [BUYER_ACCT, OTHER_FUNDER, THIRD_FUNDER];
const NO_SIGS: RefundSignatures<'static> = RefundSignatures { buyer: None, supplier: None, risk: None };

/// xorshift64*: deterministic, seedable, no external crate.
struct Gen(u64);
impl Gen {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

#[derive(Default)]
struct Shadow {
    deposited: BTreeMap<String, u128>,
    released: BTreeMap<String, u128>,
    refunded: BTreeMap<String, u128>,
    supplier_received: u128,
}

struct Run {
    w: World,
    rec: TradeRecord,
    shadow: Shadow,
    n: u64,
    manifest_rev: u64,
    /// Release attempts awaiting their transfer receipt: (intent, attempt).
    pending_release: Option<(String, String)>,
    /// Refund transfers awaiting their receipt.
    pending_refunds: Vec<String>,
    holds: Vec<String>,
    /// Exact bucket moves the step must cause, `(funder, from, to, amount)`; every other bucket of
    /// every funder must stay unchanged. `None` for steps checked by the shadow ledger instead.
    moves: Option<Vec<(String, &'static str, &'static str, u128)>>,
}

const BUCKETS: [&str; 8] = ["partial", "available", "reserved", "released", "refund_locked", "refunded", "quarantined", "fees"];

fn bucket_of(f: &dockside_escrow_core::ledger::FunderLedger, b: &str) -> i128 {
    (match b {
        "partial" => f.partial,
        "available" => f.available,
        "reserved" => f.reserved,
        "released" => f.released,
        "refund_locked" => f.refund_locked,
        "refunded" => f.refunded,
        "quarantined" => f.quarantined,
        "fees" => f.fees,
        _ => unreachable!(),
    }) as i128
}

fn field(b: Bucket) -> &'static str {
    match b {
        Bucket::Partial => "partial",
        Bucket::Available => "available",
        Bucket::Quarantined => "quarantined",
    }
}

/// Every bucket of every funder moved by exactly the expected amounts and nothing else.
fn check_moves(ctx: &str, before: &TradeRecord, after: &TradeRecord, moves: &[(String, &'static str, &'static str, u128)]) {
    for f in FUNDERS {
        let (b, a) = (before.ledger.funder(f), after.ledger.funder(f));
        for k in BUCKETS {
            let mut want = 0i128;
            for (mf, from, to, amt) in moves {
                if mf == f && *from == k {
                    want -= *amt as i128;
                }
                if mf == f && *to == k {
                    want += *amt as i128;
                }
            }
            assert_eq!(bucket_of(&a, k) - bucket_of(&b, k), want, "{ctx}: {f}.{k} moved by exactly the expected amount");
        }
    }
}

type Step = Result<&'static str, &'static str>;

fn err_code<T>(r: Result<T, dockside_escrow_core::Error>) -> Result<T, &'static str> {
    r.map_err(|e| e.code)
}

impl Run {
    fn label(&mut self, k: &str) -> String {
        self.n += 1;
        format!("{k}-{}", self.n)
    }

    fn fund(&mut self, g: &mut Gen) -> Step {
        let funder = *g.pick(&FUNDERS);
        let amount = match g.below(5) {
            0 => NEAR / 2,
            1 => 3 * NEAR,
            2 => 6 * NEAR,
            3 => 12 * NEAR, // beyond the trade amount: the remainder is QUARANTINED
            _ => 1 + g.below(1_000) as u128, // below the minimum deposit: refused
        };
        let min = dockside_escrow_core::DEFAULT_MIN_DEPOSIT_YOCTO;
        err_code(self.rec.fund(&self.w.as_caller(funder).ctx(), amount, min))?;
        self.moves = None;
        *self.shadow.deposited.entry(funder.into()).or_default() += amount;
        Ok("fund")
    }

    fn evidence(&mut self) -> Step {
        let rev = self.manifest_rev + 1;
        let n = self.label("ev");
        let (inv, rep, img) = (invoice(&format!("inv-{n}")), report(&format!("rep-{n}")), photo(&format!("img-{n}")));
        let att = attestation(&self.rec, rev, complete_slots(&self.rec, &inv, &rep, &[&img], rev), self.w.now, &format!("att-{n}"));
        let digest = err_code(self.rec.submit_manifest_attestation(&self.w.ctx(), &att, &sign("attestor", "dockside/manifest-attestation", &att)))?;
        self.manifest_rev = rev;
        let ins = inspection(&self.rec, rev, &digest, "PASS", self.w.now, &format!("ins-{n}"));
        err_code(self.rec.submit_inspection(&self.w.ctx(), &ins, &sign("inspector", "dockside/inspection-attestation", &ins)))?;
        Ok("evidence")
    }

    fn hold(&mut self, g: &mut Gen) -> Step {
        let label = self.label("hold");
        let ttl = if g.below(2) == 0 { HOUR } else { 30 * 24 * HOUR };
        let p = hold_set(&self.rec, &label, "RISK_RESOLVER", self.w.now, ttl);
        err_code(self.rec.set_hold(&self.w.ctx(), &p, &sign("risk", "dockside/hold-set", &p)))?;
        self.holds.push(label);
        Ok("hold")
    }

    fn resolve(&mut self, g: &mut Gen) -> Step {
        if self.holds.is_empty() {
            return Err("NO_HOLD");
        }
        let hold = self.holds[g.below(self.holds.len() as u64) as usize].clone();
        let n = self.label("res");
        match resolve(&self.w, &mut self.rec, &hold, "RELEASE_HOLD", &n) {
            "OK" => Ok("resolve"),
            c => Err(c),
        }
    }

    fn intent(&mut self) -> Step {
        let label = self.label("rli");
        let p = intent_payload(&self.rec, &id("rli", &label), self.w.now, &label);
        let slices = slices(&self.rec);
        let (_, joined) = err_code(self.rec.create_release_intent(&self.w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p)))?;
        assert!(!joined, "a fresh intent id never joins an existing intent");
        self.moves = Some(slices.into_iter().map(|(f, a)| (f, "available", "reserved", a)).collect());
        Ok("intent")
    }

    fn live(&self) -> Option<String> {
        self.rec.live_intent().map(|i| i.id.clone())
    }

    fn approve(&mut self) -> Step {
        let Some(i) = self.live() else { return Err("NO_INTENT") };
        let n = self.label("ap");
        match approve(&self.w, &mut self.rec, &i, &n) {
            "OK" => Ok("approve"),
            c => Err(c),
        }
    }

    fn execute(&mut self) -> Step {
        let Some(i) = self.live() else { return Err("NO_INTENT") };
        let (dest, amount, attempt) = err_code(self.rec.execute_release(&self.w.ctx(), &i))?;
        assert_eq!(dest, self.rec.terms.payout_destination, "transfer goes only to the bound destination");
        assert_eq!(amount, self.rec.terms.amount_yocto, "the whole trade amount and nothing else");
        self.pending_release = Some((i, attempt));
        Ok("execute")
    }

    fn release_receipt(&mut self, transferred: bool) -> Step {
        let Some((i, attempt)) = self.pending_release.clone() else { return Err("NO_SUBMIT") };
        let slices = intent(&self.rec, &i).slice_pairs();
        err_code(self.rec.complete_release(&self.w.ctx(), &i, &attempt, transferred))?;
        self.pending_release = None;
        let to = if transferred { "released" } else { "available" };
        self.moves = Some(slices.iter().map(|(f, a)| (f.clone(), "reserved", to, *a)).collect());
        if transferred {
            for (f, a) in slices {
                *self.shadow.released.entry(f).or_default() += a;
                self.shadow.supplier_received += a;
            }
            Ok("paid")
        } else {
            Ok("release-returned")
        }
    }

    fn cancel(&mut self) -> Step {
        let Some(i) = self.live() else { return Err("NO_INTENT") };
        let n = self.label("cancel");
        let c = cancel_payload(&self.rec, &i, "PARTIES_AGREED", self.w.now, &n);
        self.moves = Some(intent(&self.rec, &i).slice_pairs().into_iter().map(|(f, a)| (f, "reserved", "available", a)).collect());
        err_code(consent(&self.w, &mut self.rec, &c, "SUPPLIER_SIGNER", "supplier", &format!("{n}-s")))?;
        match err_code(consent(&self.w, &mut self.rec, &c, "BUYER_APPROVER", "buyer", &format!("{n}-b")))? {
            "CANCELLED" => Ok("cancel"),
            other => panic!("second matching consent must cancel, got {other}"),
        }
    }

    fn refund_request(&mut self, g: &mut Gen) -> Step {
        let funder = *g.pick(&FUNDERS);
        let reason = *g.pick(&["PARTIAL_FUNDING_RETURN", "EXCESS_FUNDING_RETURN", "MUTUAL_CANCEL", "TRADE_EXPIRY"]);
        // The amount and bucket are the contract's to compute; a caller guess is refused.
        let (bucket, mut amount) = err_code(self.rec.eligible(reason, funder, self.w.now))?;
        if g.below(6) == 0 {
            amount += 1;
        }
        let label = self.label("rfd");
        let (initiator, caller) = match reason {
            "PARTIAL_FUNDING_RETURN" | "EXCESS_FUNDING_RETURN" => ("FUNDER", funder),
            _ => ("BUYER", BUYER_ACCT),
        };
        let p = refund_req(&self.rec, &label, reason, funder, amount, bucket.as_str(), initiator, self.w.now);
        let sig = sign("buyer", "dockside/refund-request", &p);
        let sigs = if initiator == "FUNDER" { NO_SIGS } else { RefundSignatures { buyer: Some(&sig), supplier: None, risk: None } };
        let rid = err_code(self.rec.request_refund(&self.w.as_caller(caller).ctx(), &p, sigs))?;
        self.moves = Some(vec![(funder.to_string(), field(bucket), "refund_locked", amount)]);
        if reason == "MUTUAL_CANCEL" {
            let d = self.rec.refunds[&rid].request_digest_bytes;
            err_code(self.rec.cosign_refund(&self.w.ctx(), &rid, "SUPPLIER", &sign_digest("supplier", &d)))?;
        }
        Ok("refund-request")
    }

    fn live_refund(&self, g: &mut Gen, st: RefundState) -> Option<String> {
        let ids: Vec<String> = self.rec.refunds.values().filter(|r| r.state == st).map(|r| r.id.clone()).collect();
        if ids.is_empty() {
            None
        } else {
            Some(ids[g.below(ids.len() as u64) as usize].clone())
        }
    }

    fn refund_authorize(&mut self, g: &mut Gen) -> Step {
        let Some(r) = self.live_refund(g, RefundState::Timelocked) else { return Err("NO_REFUND") };
        err_code(self.rec.authorize_refund(&self.w.ctx(), &r))?;
        Ok("refund-authorize")
    }

    fn refund_begin(&mut self, g: &mut Gen) -> Step {
        let Some(r) = self.live_refund(g, RefundState::Authorized) else { return Err("NO_REFUND") };
        let (to, amount) = err_code(self.rec.begin_refund(&self.w.ctx(), &r))?;
        let row = &self.rec.refunds[&r];
        assert_eq!((to.as_str(), amount), (row.funder.as_str(), row.amount), "a refund goes only to the original funder, exact amount");
        self.pending_refunds.push(r);
        Ok("refund-begin")
    }

    fn refund_receipt(&mut self, g: &mut Gen, transferred: bool) -> Step {
        if self.pending_refunds.is_empty() {
            return Err("NO_REFUND");
        }
        let k = g.below(self.pending_refunds.len() as u64) as usize;
        let r = self.pending_refunds[k].clone();
        let (funder, amount) = (self.rec.refunds[&r].funder.clone(), self.rec.refunds[&r].amount);
        let bucket = self.rec.refunds[&r].source_bucket;
        err_code(self.rec.complete_refund(&self.w.ctx(), &r, transferred))?;
        self.pending_refunds.remove(k);
        // A transferred refund may also demote AVAILABLE to PARTIAL; the shadow ledger checks it.
        self.moves = if transferred { None } else { Some(vec![(funder.clone(), "refund_locked", field(bucket), amount)]) };
        if transferred {
            *self.shadow.refunded.entry(funder).or_default() += amount;
            Ok("refunded")
        } else {
            Ok("refund-returned")
        }
    }

    fn refund_revoke(&mut self, g: &mut Gen) -> Step {
        let r = self.live_refund(g, RefundState::Timelocked).or_else(|| self.live_refund(g, RefundState::Requested));
        let Some(r) = r else { return Err("NO_REFUND") };
        let row = self.rec.refunds[&r].clone();
        let n = self.label("rv");
        let (role, caller, signer) = match row.reason.as_str() {
            "PARTIAL_FUNDING_RETURN" | "EXCESS_FUNDING_RETURN" => ("FUNDER", row.funder.clone(), None),
            _ => ("BUYER", BUYER_ACCT.to_string(), Some("buyer")),
        };
        let p = with_header(
            &self.rec,
            vec![
                ("refundIntentId", s(&r)),
                ("requestDigest", s(&row.request_digest)),
                ("revokerRole", s(role)),
                ("issuedAt", u(self.w.now)),
                ("expiresAt", u(self.w.now + HOUR)),
                ("nonce", s(&nonce(&n))),
            ],
        );
        let sig = signer.map(|k| sign(k, "dockside/refund-revoke", &p));
        err_code(self.rec.revoke_refund(&self.w.as_caller(&caller).ctx(), &p, sig.as_deref()))?;
        self.moves = Some(vec![(row.funder.clone(), "refund_locked", field(row.source_bucket), row.amount)]);
        Ok("refund-revoke")
    }

    fn advance(&mut self, g: &mut Gen) -> Step {
        self.w.now += match g.below(4) {
            0 => 5 * 60_000,
            1 => HOUR + 1,
            2 => 25 * HOUR,
            _ => 9 * 24 * HOUR,
        };
        Ok("time")
    }

    /// A third of the steps take the next move toward a release, so PAID and returned transfers are
    /// reached often; the rest are uniformly random over every move.
    fn progress(&mut self, g: &mut Gen) -> Step {
        if self.pending_release.is_some() {
            let t = g.below(3) != 0;
            return self.release_receipt(t);
        }
        if !self.rec.ledger.fully_funded() {
            return self.fund(g);
        }
        if self.rec.current_manifest_digest(self.w.now).is_none() || self.rec.evidence.current.as_ref().is_some_and(|m| m.consumed) {
            return self.evidence();
        }
        if self.rec.blocking_holds() > 0 {
            return self.resolve(g);
        }
        match self.rec.live_intent().map(|i| i.state) {
            None => self.intent(),
            Some(IntentState::DirectTestnetAuthorized) => self.execute(),
            Some(_) => self.approve(),
        }
    }

    fn step(&mut self, g: &mut Gen) -> Step {
        if g.below(3) == 0 {
            return self.progress(g);
        }
        match g.below(17) {
            0 | 1 | 2 => self.fund(g),
            3 => self.evidence(),
            4 => self.hold(g),
            5 => self.resolve(g),
            6 => self.intent(),
            7 => self.approve(),
            8 => self.execute(),
            9 => {
                let t = g.below(3) != 0;
                self.release_receipt(t)
            }
            10 => self.cancel(),
            11 => self.refund_request(g),
            12 => self.refund_authorize(g),
            13 => self.refund_begin(g),
            14 => {
                let t = g.below(3) != 0;
                self.refund_receipt(g, t)
            }
            15 => self.refund_revoke(g),
            _ => self.advance(g),
        }
    }

    /// The contract ledger must agree with the shadow ledger and with its own live rows.
    fn check(&self, ctx: &str) {
        let l = &self.rec.ledger;
        l.check_conservation().unwrap_or_else(|e| panic!("{ctx}: contract conservation check: {}", e.message));
        let get = |m: &BTreeMap<String, u128>, k: &str| m.get(k).copied().unwrap_or(0);
        let mut released_total = 0u128;
        for f in FUNDERS {
            let fl = l.funder(f);
            assert_eq!(fl.funded, get(&self.shadow.deposited, f), "{ctx}: {f} funded equals what it sent");
            assert_eq!(fl.bucket_sum(), Some(fl.funded), "{ctx}: {f} buckets sum to funded");
            assert_eq!(fl.released, get(&self.shadow.released, f), "{ctx}: {f} released equals receipts to the supplier");
            assert_eq!(fl.refunded, get(&self.shadow.refunded, f), "{ctx}: {f} refunded equals receipts to {f}");
            assert_eq!(fl.fees, 0, "{ctx}: the direct corridor takes no fees");
            let locked: u128 = self.rec.live_refunds().filter(|r| r.funder == f).map(|r| r.amount).sum();
            assert_eq!(fl.refund_locked, locked, "{ctx}: {f} refund lock equals its live refund rows");
            for r in self.rec.live_refunds().filter(|r| r.funder == f && r.source_bucket == Bucket::Quarantined) {
                assert_eq!(r.reason, "EXCESS_FUNDING_RETURN", "{ctx}: only an excess return draws on QUARANTINED");
            }
            released_total += fl.released;
        }
        assert_eq!(released_total, self.shadow.supplier_received, "{ctx}: supplier receipts equal released value");
        assert!(released_total == 0 || released_total == self.rec.terms.amount_yocto, "{ctx}: release is all or nothing");
        assert!(l.committed() <= l.required, "{ctx}: committed value never exceeds the trade amount");
        let reserved: u128 = l.funders.values().map(|f| f.reserved).sum();
        match self.rec.live_intent() {
            Some(i) if i.state.is_pre_submit() || i.state == IntentState::Submitting => {
                assert_eq!(reserved, i.amount, "{ctx}: the live intent owns exactly the reserved value");
                assert!(l.reservation_matches(&i.slice_pairs()), "{ctx}: reservation equals the intent's slices");
            }
            Some(i) => panic!("{ctx}: unexpected live state {:?}", i.state),
            None => assert_eq!(reserved, 0, "{ctx}: no reservation without a live intent"),
        }
        let live = self.rec.release.intents.values().filter(|i| i.state.is_live()).count();
        assert!(live <= 1, "{ctx}: at most one live release intent");
        let paid = self.rec.release.intents.values().filter(|i| i.state == IntentState::Paid).count();
        assert!(paid <= 1, "{ctx}: at most one PAID intent");
    }
}

#[test]
fn t041_conservation_and_source_buckets_survive_generated_sequences() {
    const SEQUENCES: u64 = 600;
    const STEPS: usize = 70;
    let mut seen: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut refusals: BTreeMap<&'static str, u64> = BTreeMap::new();
    for seed in 1..=SEQUENCES {
        let mut g = Gen(0x9E37_79B9_7F4A_7C15 ^ seed.wrapping_mul(0xD1B5_4A32_D192_ED03));
        let (w, rec) = evidence_trade();
        let mut run = Run { w, rec, shadow: Shadow::default(), n: 0, manifest_rev: 0, pending_release: None, pending_refunds: Vec::new(), holds: Vec::new(), moves: None };
        run.check(&format!("seed {seed} start"));
        for step in 0..STEPS {
            let before = run.rec.clone();
            let pending = (run.pending_release.clone(), run.pending_refunds.clone(), run.holds.clone(), run.manifest_rev);
            run.moves = Some(Vec::new());
            match run.step(&mut g) {
                Ok(kind) => {
                    *seen.entry(kind).or_default() += 1;
                    if let Some(m) = run.moves.take() {
                        check_moves(&format!("seed {seed} step {step} {kind}"), &before, &run.rec, &m);
                    }
                }
                Err(code) => {
                    // A panicking call is reverted by the runtime: nothing it touched persists.
                    run.rec = before;
                    (run.pending_release, run.pending_refunds, run.holds, run.manifest_rev) = pending;
                    *refusals.entry(code).or_default() += 1;
                }
            }
            run.check(&format!("seed {seed} step {step}"));
        }
    }
    // The generator must actually reach every economic outcome, not only refusals.
    for kind in [
        "fund", "evidence", "hold", "resolve", "intent", "approve", "execute", "paid", "release-returned", "cancel",
        "refund-request", "refund-authorize", "refund-begin", "refunded", "refund-returned", "refund-revoke", "time",
    ] {
        assert!(seen.get(kind).copied().unwrap_or(0) > 0, "generated sequences never reached {kind}: {seen:?}");
    }
    for c in ["STALE_LEDGER", "INVALID_AMOUNT", "HOLD_ACTIVE", "NOTHING_ELIGIBLE"] {
        assert!(refusals.get(c).copied().unwrap_or(0) > 0, "generated sequences never exercised refusal {c}: {refusals:?}");
    }
    println!("T-041 outcomes: {seen:?}");
    println!("T-041 refusals: {refusals:?}");
}
