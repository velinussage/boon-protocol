---
title: x402
description: How paid API requests work on Base.
---

# x402

> **Hosted API boundary:** These pages document the public hosted API at `api.boonprotocol.com`, consumed by the open-source clients in this repository. The onchain Boon protocol itself requires no x402: the contract, EIP-712 vouchers, canonical handle rules, and USDC settlement are separate.

This page is the public integration reference for Boon's x402 surface. The companion [x402 Graph](/api-reference/x402-paid-endpoints/) page lists route shapes and launch pricing.

Boon uses x402 for endpoint discovery reads, detailed graph/scoring reads, and third-party private-tip reveals. Sending, claiming, aggregate points, profiles, receipts, attestation pages, human website browsing, and recipient/tipper private reads remain free.

## Routed recognition discovery

### Agent discovery sequence

The endpoint-review graph has a one-cent starting point. Agents should not guess a
route ID or use the handle gratitude graph as an endpoint catalog.

```http
GET /api/v1/x402/graph?sort=reviewed&context=with&limit=20
GET /api/v1/x402/routes?sort=reviewed&context=with&limit=20
GET /api/v1/x402/routes/:routeId
GET /api/v1/x402/routes/:routeId/recognitions?limit=25&offset=0
GET /api/v1/x402/routes/:routeId/reviews?limit=25&offset=0
```

Every read above costs `$0.01` through x402 or MPP. The graph supplies endpoint
and wallet nodes plus `recognized`, `reviewed`, and `described` edges. The
compact directory supplies real route IDs, endpoint descriptions,
`reviewSummary`, USDC recognition, `$BOON` burned, and next-step links.
`reviewSummary` separates `selfReportedCount` opinion volume and
`receiptVerifiedCount` usage volume from `boonBackedCount` conviction. `sort=reviewed` uses only Boon-backed review
count, distinct Boon-backed reviewers, USDC recognition, then recency.
Self-reported and receipt-verified volume never change this order. It is a factual navigation
order, not a star score or universal quality ranking. Direct related-party
flags compare wallet addresses only. A clean flag does not prove different
beneficial ownership or control.

Calling the listed third-party endpoint is a separate x402 action outside Boon.
Sending a routed Boon afterward is also separate and approval-gated.

`GET /api/v1/x402/graph` is the preferred paid discovery surface when wallet
relationships matter. `GET /api/v1/x402/routes` is a smaller paid directory for
described endpoints that received a routed Boon. Each
routed recognition sends explicit USDC recognition to the endpoint and
optionally the discovery network, then burns a fixed 100,000 `$BOON` from the
sender.

The route ID and monetary record are onchain. Method and URL descriptions can
be joined to that record by recomputing the route ID. Dated service, price, and
request metadata remains attributed to its discovery source and may change. A
route participant can separately publish a time-bounded signed route note
through `POST /api/v1/x402/route-contexts`. Discovery defaults to `context=with`,
so a hash-only record is not presented as an endpoint listing. Consumers must
keep these claims separate:

- onchain events prove the recorded USDC amounts, wallet roles, timestamp, and
  fixed `$BOON` burn;
- a valid signature proves the publisher signed the exact route-note bytes;
- a Boon OAuth link resolves a participant wallet to a GitHub or X handle, but
  does not strengthen the endpoint claim;
- neither fact proves that an x402 purchase occurred, that an endpoint was
  used, or that its response is safe or good;
- Boon displays endpoint and artifact references without fetching them.

Reviews have three evidence lanes. All are wallet-signed, subjective, limited to
1000 UTF-8 bytes, and have no stars or numeric score:

- **Self-reported V3:** any EVM wallet may pay `$0.05` through x402 or MPP to
  publish one opinion per recognized route without OAuth, provider receipt
  adoption, or a `$BOON` burn. It proves wallet signature authority only,
  contributes visible participation volume, and is excluded from ranking.

- **Receipt-verified V2:** any EVM wallet that is the payer on an official
  signed x402 offer and receipt may review the matching described route. The
  Boon API verifies the service signer and `payTo` against the route's separate,
  dated `receiptAuthority.signer` and `receiptAuthority.payTo` pins, then verifies the payer, Base network, exact
  resource URL, amount, timestamps, receipt digest, and review signature. It
  accepts EOA and Safe/ERC-1271 signatures. Publication costs `$0.01` through
  x402 or MPP, needs no OAuth, carries no gratuity, burns no `$BOON`, contributes visible usage
  volume, and is excluded from discovery ranking.
  `receiptAuthority.status: "not_observed"` means the provider has not exposed
  the official extension yet, so the receipt lane stays unavailable rather than
  treating a basic settlement header as proof. A separate signer lets settlement
  continue to a treasury Safe without making the Safe sign every response.
- **Boon-backed V1:** the tipper from a cited `RoutedBoon` event may publish a
  review without an additional API charge. It reviews that
  route. Its signature binds the route, transaction, log index, text, Base
  chain, and companion contract. The page shows its nonzero USDC gratuity and
  fixed 100,000 `$BOON` burn. It participates in the conviction ranking.

Paid publication is loss-safe across storage retries. The Boon API records
`reserved_unpaid`, then `settled_pending`, then `published`; a definitively
failed authorization moves through durable `cancel_pending` cleanup so it cannot
lock the wallet's lane. If settlement succeeds but publication cannot finish
immediately, the API returns `202` with the x402 or MPP receipt plus
`retryWithoutRecharge: true`. Retry the identical signed bundle with the same
payment authorization. Boon does not settle it again, and a scheduled
publication task also promotes durable settled records.

If both server stores are unavailable after settlement, the receipt-bearing
`202` is explicitly labeled `settlement_receipt_uncheckpointed` rather than
claiming durable server state. Preserve that receipt and retry only the identical
bundle with the same authorization. Do not authorize a replacement payment.

OAuth-linked GitHub or X accounts and ERC-8004 identities are additive display
context, never review eligibility gates. Wallet and receipt verification make
authorship accountable; no evidence lane proves objective quality, safety,
independent ownership, or response content.

Explicit `context=all` and `context=raw` reads remain available for index and
transaction verification. They are not the default human or agent discovery
surface.

Human browsing lives at `https://boonprotocol.com/x402`. Programmatic reads are
also available through `boon x402 search`, `boon x402 route`, and
`boon x402 recognitions`. Review history is available through
`boon x402 reviews --route <routeId>` or `boon x402 reviews --reviewer <wallet>`.
These CLI commands never sign or settle a read automatically. Use an
x402-capable client such as AgentCash for the one-cent sign-and-retry flow.
Publishing signed context is explicit through
`boon x402 route-note publish-context`. Route detail responses include the
exact signed payload for independent verification; list responses use a compact
parsed summary.

Review preparation and publication are explicit. Install the public CLI from
npm. The package is scoped, but the executable remains `boon`:

```bash
npm install --global @velinussage/boon-cli
boon --version
```

```bash
boon x402 review self submit \
  --route 0x... \
  --text "The interface looks useful; I am not claiming that I used it." \
  --wallet <policy-scoped-ows-wallet> \
  --confirm-subjective \
  --yes

boon x402 review sign \
  --route 0x... \
  --transaction 0x... \
  --log-index 1 \
  --text "Strong for narrow research queries; weaker at page-level extraction." \
  --signer 0x... \
  --confirm-used

boon x402 review prepare \
  --route 0x... \
  --transaction 0x... \
  --log-index 1 \
  --text "Strong for narrow research queries; weaker at page-level extraction." \
  --contract 0x... \
  --json

boon x402 review publish \
  --review-json ./review.json \
  --signature 0x...

boon x402 review receipt prepare \
  --route 0x... \
  --offer-json ./offer.json \
  --receipt-json ./receipt.json \
  --text "Useful parcel match with clear citations."

boon x402 review receipt submit \
  --route 0x... \
  --offer-json ./offer.json \
  --receipt-json ./receipt.json \
  --text "Useful parcel match with clear citations." \
  --wallet <policy-scoped-ows-wallet> \
  --confirm-used \
  --yes
```

The `review self` commands are the `$0.05` V3 flow and explicitly avoid a claim
of use. The `review receipt` commands are the `$0.01` V2 flow. `prepare` verifies
the official offer and receipt and emits typed data without signing. `submit`
requires the selected OWS wallet to equal the receipt payer. `receipt publish`
accepts an externally signed V2 bundle, including a smart-wallet signature, and
requires an OWS payment wallet. The direct `review` commands are the V1
Boon-backed flow and add no publication charge.

The provider must emit the x402 `offer-receipt` extension. A normal unsigned
payment challenge or basic `PAYMENT-RESPONSE` header is not sufficient. CLI
preparation checks that the two signed artifacts agree; the Boon API additionally
requires their recovered signer and signed `payTo` to equal the independent
service-signer and payment-recipient pins in the route directory. A provider
key or treasury rotation requires a directory refresh before new receipt
reviews can publish. Boon stores both as publication-time facts, so later
rotations do not erase valid review history. The endpoint must already have at least one routed Boon
in the public graph, but the receipt reviewer does not need to be that
recognizer and does not burn BOON.

The V1 `sign` command opens Boon's hosted MetaMask signing page with a short-lived payload in
the URL fragment. The page removes the fragment on load, verifies the exact
routed-Boon receipt and required signer, and asks MetaMask for final approval.
It cannot change the CLI's review text. The route page provides a three-lane
composer for any connected wallet. Review publication sends no gratuity and
burns no `$BOON`: V3 costs `$0.05` and is self-reported, V2 costs `$0.01` and
attaches text to one canonical receipt digest, and V1 adds no publication charge
because it attaches text to a routed Boon that already burned 100,000 `$BOON`.
Only V1 is ranked. The required confirmation statements remain subjective.

Calling, reviewing, and sending a Boon remain distinct. Calling buys or consumes
the third-party service. Reviewing publishes a signed subjective statement and
sends no gratuity. Sending a routed Boon is a separate onchain act of gratitude
and quality conviction with nonzero USDC and irreversible burn. It grows the
ranked gratuity graph that future viewers can use for discovery, without
promising any financial benefit to them.

`POST /api/v1/x402/reviews` is the signer-gated V1 publication route without
another API charge. V2 and V3 use their evidence-specific paid publication
routes. Every official `GET /api/v1/x402/*` read is a one-cent x402 or MPP
endpoint and is listed in the hosted OpenAPI document. Paid responses use
`Cache-Control: private, no-store` so a shared cache does not replay the paid
payload to another caller.

## How it works

Boon's hosted API implements the x402 server side. Clients need no Boon-specific
x402 packages or credentials. Read the payment requirements from the `402`
challenge and satisfy them with any x402-capable client via the normal retry
flow.

## Header flow

1. Client calls a paid endpoint without payment.
2. Boon API returns `402 Payment Required` and a `PAYMENT-REQUIRED` challenge.
3. Client signs the payment payload.
4. Client retries with `PAYMENT-SIGNATURE`.
5. Boon API verifies and settles through the facilitator.
6. Boon API returns the JSON response and `PAYMENT-RESPONSE`.

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
  The SPA uses separate compact website display routes. Official
  `/api/v1/x402/*` reads stay paid regardless of caller headers.
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

- Recipient-handle points come from the hosted recipient projection.
- Sender-wallet points come from the hosted sender projection.
- Per-handle `sentPoints` joins a linked wallet to sender history. Handles with
  no linked wallet
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
