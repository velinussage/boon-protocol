---
title: Data layer (subgraph)
description: How Boon indexes onchain events into the entities that back board, points, profile, receipt, and graph reads.
---

# Data layer (subgraph)

Almost every Boon read — board, points, profile, receipt, gratitude graph — is served by the Worker reading a Goldsky-hosted subgraph that indexes Boon events on Base. Understanding the entity model is the fastest way to debug "data looks stale" or to integrate a new endpoint.

## Indexed events

The contract emits events that the subgraph consumes:

| Event | What it produces |
|---|---|
| `Tip(...)` | A public `Tip` entity, `Recipient` + `Tipper` rollups, and Boon Points attributions. |
| `TipEscrowed(...)` | A pending public `Tip` entity for a walletless GitHub/X handle. |
| `PrivateTip(...)` | A private direct-settlement `Tip` entity with private commitment metadata and `$BOON` burn rollups. |
| `PrivateTipEscrowed(...)` | A pending private `Tip` entity for a walletless GitHub/X handle. |
| `Linked(...)` / `Relinked(...)` | `Recipient.linkedWallet`, link audit entries, `HandleHashIndex`, and `Stats` updates. |
| `EscrowedClaimed(...)` | A `Claim` entity and status transition from `ESCROWED` to `CLAIMED`. |
| `EscrowedRefunded(...)` | Refund audit data and status transition away from pending recipient claimability. |
| `Attestation mint event` | Immutable attestation rows used by SBT metadata and attestation pages. |

## Entities

- **Tip** — every public or private tip event, with `status` ∈ `ESCROWED | PUSHED | CLAIMED | REFUNDED`. Private tips keep note and amount null in the public read path.
- **Recipient** — aggregated per canonical handle: `totalReceived`, pushed/escrowed/claimed splits, `linkedWallet`, recipient-side public points, and private-tip counts.
- **Tipper** — aggregated per sender wallet: `totalSent`, `tipCount`, private-tip counts, sender-side public points, and `$BOON` burned for private/proof actions.
- **Link** — discrete handle ↔ wallet binding events.
- **Claim** — discrete claim sweeps for audit/history.
- **HandleHashIndex** — reverse lookup from `handleHash` to canonical handle.
- **Stats** — global singleton: `totalTipped`, `tipCount`, `privateTipCount`, `uniqueRecipients`, `uniqueTippers`, `linkedRecipients`, current points policy version.
- **Attestation** — immutable per-SBT proof row keyed by Boon tip ID.
- **TipperRecipientDay**, **RecipientSender**, **RecipientEpochBonus** — persistent rollups for anti-farming and independent-sender accounting. These must live in the subgraph so the rules stay deterministic.

## Which endpoints read which entities

| Endpoint | Source |
|---|---|
| `GET /api/v1/board` (and `/api/leaderboard` alias) | `Recipient` (top by `totalReceived`) + `Tipper` + `Stats` |
| `GET /api/v1/handles/:handle/points` | `Recipient` (handle points) + join to `Tipper` via `linkedWallet` for `sentPoints` |
| `GET /api/v1/handles/:handle/profile` | Points envelope + `Recipient` aggregates |
| `GET /api/v1/receipts/:txHash` | `Tip` by tx hash + `Recipient` + `Tipper` |
| `GET /api/v1/attestations/:tipId` | Onchain SBT read + `Attestation`-compatible metadata shape |
| `GET /api/v1/handles/:handle/boons` (paid) | `Tip` filtered by handle |
| `GET /api/v1/graphs/gratitude` (paid) | `Tip` traversed into handle / repo-filtered graph |

If a handle has no `linkedWallet`, the Worker reports `sentPointsSource: "unlinked"` rather than silently zeroing the sender-side points.

## Deploy and provenance

The hosted subgraph deployment is operated with the private service code. Public integrators should treat `api.boonprotocol.com` and the live Base contracts as the source of truth for production reads, and use BaseScan plus the public API responses when debugging a specific receipt, profile, or board row.

## "Data looks stale" — diagnose before assuming contract bugs

Index lag is the most common cause of a read that does not match the chain. Before assuming the contract is wrong:

1. Look up the tx on BaseScan to confirm the block.
2. Query the subgraph's `_meta { block { number } }` to see how far behind it is.
3. Wait a block or two, then re-fetch.

If the lag persists or `Stats` totals look wrong, that's a subgraph issue, not a contract issue. See [Troubleshooting → Data looks stale](/guides/troubleshooting/#data-looks-stale).

## Reference

This page documents the public read model exposed by `api.boonprotocol.com`. The hosted subgraph implementation and deployment runbooks are maintained with the private service code; the public source repository is [`velinussage/boon-protocol`](https://github.com/velinussage/boon-protocol).
