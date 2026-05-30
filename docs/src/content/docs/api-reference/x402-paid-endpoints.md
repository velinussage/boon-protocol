---
title: x402 Graph
description: Paid graph and scoring endpoints for agents and apps.
---

# x402 Graph

> **Hosted API boundary:** These pages document the public hosted API at `api.boonprotocol.com`, consumed by the open-source clients in this repository. The onchain Boon protocol itself requires no x402: the contract, EIP-712 vouchers, canonical handle rules, and USDC settlement are separate.

These endpoints require x402 payment from callers that are not otherwise authorized. The Boon SPA stays free for public product reads because it only calls the public data surfaces, not because of an Origin allowlist. Recipient/tipper private reads are free after EIP-712 auth; third-party private-tip reveals are x402-paid. See [x402 protocol](/api-reference/x402-protocol/) for the
full header flow, networks, facilitators, security rules, and deployment
gates.

Base URL: `https://api.boonprotocol.com`

## Launch pricing

| Key | Route | Price |
|---|---|---:|
| `boons` | `GET /api/v1/handles/:handle/boons` | `$0.002` |
| `graph` | `GET /api/v1/graphs/gratitude?…` | `$0.005` |
| `queriesBase` | `POST /api/v1/graphs/queries` | `$0.01` |
| `score` | `POST /api/v1/score` | `$0.005` |
| `privateTipUnlock` | `GET /tips/:tipId` without recipient/tipper auth | `$1 USDC` |

Batch graph queries currently use a flat `$0.01` launch price for the route, regardless of the number of requested handles within the public limit. The base paid route is not priced below `$0.002` so the CDP facilitator's per-transaction fee outside the monthly free tier does not push the route into negative margin.

## Per-handle boon list

```http
GET /api/v1/handles/:handle/boons?limit=50
```

Returns chronological detailed tips for a canonical recipient handle.
Launch price: `$0.002`.

## Gratitude graph

```http
GET /api/v1/graphs/gratitude?handle=github:alice&limit=100
GET /api/v1/graphs/gratitude?repo=owner/repo&limit=100
```

Returns graph nodes and edges. Repo filtering is based on deterministic
note markers until a future indexed artifact field exists. Launch price:
`$0.005`.

## Batch graph queries

```http
POST /api/v1/graphs/queries
Content-Type: application/json

{ "handles": ["github:alice", "x:bob"], "limit": 100 }
```

Returns graph edges across up to 25 canonical handles. Launch pricing is the flat `queriesBase` `$0.01` route price.

## Private-tip unlock

```http
POST /tips/:tipId/auth-challenge
GET  /tips/:tipId
```

The original tipper and authorized recipient can read the private note/amount for free by signing the challenge from `POST /tips/:tipId/auth-challenge` and sending the auth headers on `GET /tips/:tipId`.

A third party that does not have recipient/tipper auth can call `GET /tips/:tipId` and satisfy the x402 challenge. The price is the immutable `UNLOCK_PRICE_USDC()` set on Boon (launched value: `$1 USDC`). Payment settles directly to the original tipper for that private tip (not to the Boon Safe).

## Suggested boon score

```http
POST /api/v1/score
Content-Type: application/json

{
  "recipient": "github:alice",
  "tipper": "0x...",
  "amount": "5",
  "note": "pr:owner/repo#42: review"
}
```

Returns a conservative suggested amount and rationale based on Boon Points
and artifact-linked note context. Launch price: `$0.005`.

## Unpaid request behavior

An unpaid request returns:

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <challenge>
```

The paid client signs the challenge and retries with `PAYMENT-SIGNATURE`.
On success, the server returns `PAYMENT-RESPONSE` plus the JSON body.

## Payment recipients

Graph/scoring paid-route revenue settles to the Boon team Safe:

```text
0x9eD16E6E1c0eA4f3739d1cF23041ed7aA782c08F
```

Private-tip unlock revenue settles dynamically to the original tipper for that tip. The x402 challenge for `/tips/:tipId` should be read per response; do not assume the Safe is the recipient for private-tip unlocks.

A `402` challenge response alone is **not** proof that end-to-end paid
settlement has been validated. See
[x402 protocol → Verifying a paid integration](/api-reference/x402-protocol/#verifying-a-paid-integration).
