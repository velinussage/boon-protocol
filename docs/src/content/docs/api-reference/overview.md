---
title: API overview
description: Free reads, paid graph reads, and hosted API limits.
---

# API overview

> **Hosted API boundary:** These pages document the public hosted API at `api.boonprotocol.com`, consumed by the open-source clients in this repository. The onchain Boon protocol itself requires no x402: the contract, EIP-712 vouchers, canonical handle rules, and USDC settlement are separate.

Boon's API is split along a product boundary, not a holder-tier boundary.

- **Free public reads** back the hosted human UX: board, profile pages,
  receipt verification, attestation metadata, and policy. They are an
  implementation detail of the Boon web app, not a general-purpose public data
  API.
- **Private-tip auth reads** let the original tipper or recipient reveal private
  details for free after an EIP-712 challenge.
- **x402-paid graph reads** are the agent / app / indexer surface for
  structured gratitude-graph extraction. Anything chronological, per-handle, or
  graph-shaped is monetized by default.
- **x402 private-tip unlocks** reveal a single private tip to third parties for
  the fixed `$1 USDC` price paid to the original tipper.

Treat the free surface as "what the product UI needs to render itself" and the
paid surface as "what an external system needs to build on Boon." If you find
yourself wanting a chronological feed, a per-handle boon list,
artifact-filtered edges, or third-party private-tip detail, you are on the paid
side of the boundary.

## Base URLs

| Surface | URL |
|---|---|
| App | `https://boonprotocol.com` |
| API | `https://api.boonprotocol.com` |

## Data units

USDC amounts are returned as decimal strings in base units, with 6 decimals.
`2000000` means 2 USDC.

Points are scaled integers. The public policy endpoint reports
`pointScale: "1000"`. See [x402 protocol → Boon Points model](/api-reference/x402-protocol/#boon-points-model)
for the full scoring shape.

## Public data surfaces

These endpoints back the hosted UX. They are stable but intentionally
aggregate-only. There is no public chronological feed and no per-handle list
on the free side.

### Health

```http
GET /health
```

Returns API readiness:

```json
{ "ok": true, "version": "<current>" }
```

(The exact response may include additional diagnostic fields and can change across releases.)

### Points by handle

```http
GET /api/v1/handles/:handle/points
```

Aggregate Boon Points for a canonical handle. Notable fields: `points`,
`decayedPoints`, `receivedPoints`, `sentPoints`, `sentPointsSource`,
`boonsSent`, `boonsReceived`, `linkedWallet`, `policyVersion`.

### Profile by handle

```http
GET /api/v1/handles/:handle/profile
```

The points envelope plus aggregate profile totals: `totalReceived`,
`pushedAmount`, `escrowedAmount`, `claimedAmount`, `totalSent`, `firstTipAt`,
`lastTipAt`. There is no per-boon list in this response. That is the paid
surface.

### Receipt by transaction hash

```http
GET /api/v1/receipts/:txHash
```

One indexed boon receipt. This is how a sender or recipient verifies a known
boon without a browsable public feed.

### Board

```http
GET /api/v1/board?limit=25
```

Top recipients, tippers, and aggregate stats for ranking.
`GET /api/leaderboard` is retained as a compatibility alias.

### Sender wallet profile

```http
GET /api/v1/wallets/:address/sent
```

Aggregate sender-side totals for a known wallet, used by the hosted sender profile page. This does not expose a chronological send list; detailed per-handle and graph reads remain on the paid side.

### Points policy

```http
GET /api/v1/points/policy
```

The versioned scoring rules use the same `policyVersion` value referenced from
points and profile responses.

### Attestation metadata

```http
GET /api/v1/attestations/:tipId
```

ERC-721-compatible metadata for a Boon gratitude attestation. The metadata
links back to `boonprotocol.com/attestations/:tipId` and includes tip ID,
recipient wallet, agent ID when present, `$BOON` burned, and mint time. It does
not reveal private-tip note text or private amount.

### Private-tip blob upload

```http
POST /api/v1/private-tip-blobs
```

App/CLI upload path for encrypted private-tip metadata before `tipPrivate(...)` settlement. This is a write path used by Boon clients, not a public browsing endpoint.

### Private commitment previews

```http
GET /api/v1/private-tips/pending?handle=github%3Aalice
```

The pending-list endpoint returns recipient-safe previews for a canonical handle without exposing private note text, private commitments, or blob contents. It helps the claim UI show that private Boons may be waiting while preserving the private read boundary.

### Sender disclosure

```http
GET    /api/v1/boons/:txHash/disclosure
POST   /api/v1/boons/:txHash/disclosure
DELETE /api/v1/boons/:txHash/disclosure
```

`GET` is public and reads optional sender disclosure metadata for a known
receipt. `POST` and `DELETE` require a sender EIP-712 signature and are
verified against the indexed tipper for that receipt. See
[Authentication → Sender disclosure signature](/api-reference/authentication/#sender-disclosure-signature).

### Private-tip authorized read

```http
POST /tips/:tipId/auth-challenge
GET  /tips/:tipId
```

The challenge endpoint returns an EIP-712 domain/types payload for a short-lived
private-tip unlock nonce. The original tipper or authorized recipient signs the
challenge and calls `GET /tips/:tipId` with auth headers to read for free.
Without those auth headers, `GET /tips/:tipId` uses the x402 fixed-price reveal
flow, with payment settling to the original tipper.

### Retired feed

```http
GET /api/feed
```

The public feed is deliberately retired and returns gone/not-found with a
replacement hint. Use aggregate endpoints for public reads, or the x402-paid
per-handle list for chronological detail.

## Paid graph surface

The paid surface is the agent / indexer product:

- per-handle boon list
- fixed-price third-party private-tip unlocks
- handle-centered gratitude graph
- repo / artifact-filtered graph
- batch graph queries
- suggested boon score

Unpaid requests return `402 Payment Required` with a `PAYMENT-REQUIRED`
challenge. See [x402 Graph](/api-reference/x402-paid-endpoints/) for
shapes and pricing, and [x402 protocol](/api-reference/x402-protocol/) for the
header flow, networks, facilitators, security rules, and points model.

## Privacy boundary

Boon's free surfaces show aggregate reputation and receipt-level verification.
Detailed graph, list, edge data, and third-party private-tip details are intentionally behind x402 so that agents and apps pay for structured reads instead of getting a public feed by default. Do not add free endpoints that expose chronological who-paid-who data or unauthenticated private-tip detail.
