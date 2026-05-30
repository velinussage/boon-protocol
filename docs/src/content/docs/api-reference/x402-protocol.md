---
title: x402
description: How paid API requests work on Base.
---

# x402

> **Hosted API boundary:** These pages document the public hosted API at `api.boonprotocol.com`, consumed by the open-source clients in this repository. The onchain Boon protocol itself requires no x402: the contract, EIP-712 vouchers, canonical handle rules, and USDC settlement are separate.

This page is the public integration reference for Boon's x402 surface. The companion [x402 Graph](/api-reference/x402-paid-endpoints/) page lists route shapes and launch pricing.

Boon uses x402 for two paid surfaces: detailed graph/scoring reads and third-party private-tip reveals. Sending, claiming, aggregate points, profiles, receipts, attestation pages, and recipient/tipper private reads remain free.

## How it works

Boon's hosted API implements the x402 server side. Clients need no Boon-specific
x402 packages or credentials. Read the payment requirements from the `402`
challenge and satisfy them with any x402-capable client via the normal retry
flow.

## Header flow

1. Client calls a paid endpoint without payment.
2. Worker returns `402 Payment Required` and a `PAYMENT-REQUIRED` challenge.
3. Client signs the payment payload.
4. Client retries with `PAYMENT-SIGNATURE`.
5. Worker verifies/settles through the facilitator.
6. Worker returns the JSON response and `PAYMENT-RESPONSE`.

## Networks

Network identifiers are CAIP-2 strings.

| Environment | Network |
|---|---|
| Sandbox examples | `eip155:84532` (Base Sepolia) |
| Production | `eip155:8453` (Base mainnet) |

Production Base USDC:

```text
0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

## Facilitators

The repo configuration supports:

- **Sandbox / test:** `https://x402.org/facilitator`, signup-free on Base Sepolia.
- **Production CDP:** `https://api.cdp.coinbase.com/platform/v2/x402`, Base mainnet.

Production facilitator credentials are managed by Boon maintainers and are not required for ordinary API clients. Clients should read payment requirements from the returned `402 Payment Required` challenge rather than hard-coding facilitator or recipient settings.

## Public payment parameters

Each paid response challenge tells the client what to pay and where to submit settlement. For Boon's public hosted API:

| Parameter | Public behavior |
|---|---|
| Network | Base mainnet (`eip155:8453`) for production. |
| Asset | Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). |
| Recipient | Graph/scoring reads pay Boon. Private-tip unlocks route reveal payments to the original tipper. |
| Facilitator | Included in the x402 challenge / retry flow. |

## Security rules

- Do not bypass payment based on `Origin`; non-browser clients can spoof it.
  The SPA stays free because it calls only the free endpoints listed in
  [API overview → Public data surfaces](/api-reference/overview/#public-data-surfaces),
  not because of an Origin allowlist on paid routes.
- Bind/check the x402 `resource` per route so a payment receipt for one
  endpoint cannot be replayed against another.
- Do not log payment signatures or full payment payloads.
- Return a generic unavailable/payment error to clients when the facilitator
  is down; log structured upstream detail server-side only.
- Sender disclosure writes (`POST` / `DELETE /api/v1/boons/:txHash/disclosure`)
  must be EIP-712-verified against the indexed tipper. Unauthenticated
  disclosure is a privacy bug.
- Keep claim, viewing, and recipient help out of paid endpoints.
- Private-tip unlocks use route-specific dynamic `payTo = original tipper`; do not route those reveal payments to the Boon Safe.
- Refuse to advertise a private-tip x402 challenge if the onchain unlock price is zero, the tipper is zero, or production x402 configuration is missing.

## Boon Points model

Boon Points are non-transferable, non-redeemable, public reputation derived
from onchain `Tip` events plus OAuth-linked wallets.

- Recipient-handle points live on the subgraph `Recipient` entity.
- Sender-wallet points live on the `Tipper` entity.
- Per-handle `sentPoints` is a Worker read-side join from
  `Recipient.linkedWallet` → `Tipper.id`. Handles with no linked wallet
  return `sentPointsSource: "unlinked"`.
- Points use scaled integers (`POINT_SCALE = 1000`) so fractional rules stay
  deterministic.
- Pair/day anti-farming state is indexed deterministically in the public data
  layer.
- The contract event does not include `artifactHash`; repo/artifact bonuses
  use deterministic note markers unless a future contract field is added.

The public policy endpoint (`GET /api/v1/points/policy`) returns the
versioned rules and `pointScale`.

## Disclosure storage

Optional sender disclosure metadata is served by the hosted API. Reads are
public; writes and deletes require sender EIP-712 verification per the
security rules above. Clients should treat the hosted API and onchain
receipts as the public contract for this data surface.

## Verifying a paid integration

Validation commands a public integrator can run against the hosted API:

```bash
# A 402 challenge response (no payment sent)
curl -i 'https://api.boonprotocol.com/api/v1/handles/github:alice/boons?limit=1'

# Public-side typecheck / build for an SDK or app that consumes the API
pnpm --filter boon-app typecheck
pnpm --filter boon-app build
```

A `402 Payment Required` with a `PAYMENT-REQUIRED` header is **not** by
itself proof that paid settlement works end to end. The only authoritative
test is to sign a real payment payload, retry with `PAYMENT-SIGNATURE`, and
confirm the settled USDC transfer on Base. For production integrations,
validate the full pay-and-retry flow with a small amount before relying on
paid reads in automation.

## References

- [x402 Graph](/api-reference/x402-paid-endpoints/): route shapes
  and launch pricing.
- [Authentication](/api-reference/authentication/): voucher and disclosure
  signature shapes.
- Coinbase x402 docs: <https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works>
- x402 network support: <https://docs.cdp.coinbase.com/x402/network-support>
- Cloudflare x402 Workers docs: <https://developers.cloudflare.com/agents/agentic-payments/x402/>
