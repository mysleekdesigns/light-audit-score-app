---
name: licensing
description: LightAudit license and entitlement design — Ed25519-signed offline-verifiable tokens, device fingerprint binding and seat caps, offline grace and read-only degrade, Stripe webhook idempotency, Better Auth setup, keychain storage, kill-switch, Keygen CE option. Use for SAAS_PLAN.md Phase B, Phase C, or Phase E Tier-3 work.
---

# Licensing & entitlements for LightAudit

Authoritative plan: `SAAS_PLAN.md` §4 ("License cloud") + Phases B, C, E Tier 3. The model is
JetBrains-style: account-based online activation, signed offline-verifiable entitlements,
graceful degrade — never a hard brick. The durable anti-piracy moat is server-side features
(Phase F), not local checks.

## Entitlement token

- Ed25519-signed (JWT-like). Claims: `sub` (account), `plan`, `features[]`, `deviceId`
  (fingerprint binding), `iat`, `exp` (≤ 7 days), `graceDays`.
- Public key pinned/hard-coded in the app (Phase E: bytecode + `protectedStrings`); private
  key only in the license cloud. A key-swap forging attempt must fail verification.
- Verification is fully offline: signature → claims → expiry+grace against **anchored server
  time** (persist the server timestamp from the last successful refresh; never trust the
  client clock alone — clock tampering must not extend grace; Phase C gate tests this).
- Refresh on launch and ~every 24h. Refresh denial (refund/chargeback/abuse) = kill-switch;
  effect is only that the token eventually expires into read-only.

## Lifecycle & state machine

`trial (14d, no card) → active → [payment failure → past_due grace] → expired → read-only`.
Read-only = history viewable, exports allowed, no new audits; renewal recovers instantly.
Trial entitlement minted on signup; Turnstile + email verification deter trial abuse (and
no more than that — see Risk Register).

## Device registry & seats

- Fingerprint: stable machine ID (e.g. `node-machine-id`-style), hashed; stored server-side
  per activation. Caps: Solo 2, Pro 3, Team 3/seat (`SAAS_PLAN.md` §3).
- Flow: validate → activate (register device) → revalidate. Users deactivate old devices in
  the web dashboard. Rate-limit activation/deactivation churn to deter license rotation.

## Stripe rules (Phase B)

- Webhooks: verify signatures; idempotency table keyed by `event.id`; tolerate out-of-order
  and duplicate delivery; subscription state in Postgres is the single source of truth and
  entitlements are derived from it on mint — never cached independently.
- Products/prices: Solo $12 / Pro $24 / Team $49 monthly + annual (2 months free), Checkout
  + Customer Portal. Map `subscription.status` → entitlement plan/features in ONE function
  with exhaustive tests (trialing, active, past_due, canceled, unpaid).

## App-side storage & enforcement (Phase C)

- Token in OS keychain only (Keychain/DPAPI/libsecret; Electron `safeStorage` is acceptable) —
  never plaintext on disk. Activation: system-browser OAuth → deep link back (validate input).
- Feature flags read from entitlement claims; cloud-touching features (sync, teams, update
  channel) are re-checked **server-side** — client claims are UI hints, not authorization.
- License verification duplicated across call sites, signature check inseparable from
  feature-flag reads (Phase E Tier 4) — but assume a determined cracker wins locally.

## Build vs buy

Research-verified recommendation: **Keygen CE** (free self-host for commercial use, Fair Core
License) provides signed offline license files, machine fingerprinting, activation caps, and
offline-grace fields out of the box; self-host (Docker + Postgres + Redis) vs Keygen Cloud is
an ops trade. Hand-rolling the Ed25519 flow is acceptable for launch if it stays this simple —
decide in Phase B and record the decision in SAAS_PLAN.md.

## Test matrix (minimum, per slice)

Token: valid / expired / in-grace / tampered payload / wrong key / clock-rolled-back.
Webhooks: duplicate event / out-of-order pair / signature failure.
Devices: cap reached / deactivate-reactivate / churn rate limit.
