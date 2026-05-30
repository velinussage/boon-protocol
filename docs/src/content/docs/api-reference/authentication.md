---
title: Authentication
description: How Boon proves recipient handle ownership, sender disclosure intent, and private-tip read permission.
---

# Authentication

Boon doesn't issue public API keys for product actions. Authenticated actions use EIP-712 signatures that the contract or Worker verifies against the Boon domain for Base.

There are four distinct auth surfaces:

| Surface | Who signs | Why | Read for exact domain |
|---|---|---|---|
| Recipient link voucher | trustedSigner (Boon Worker), plus guardian when pending USDC exists | Prove a GitHub or X handle belongs to a wallet | [contract addresses](/resources/contract-addresses/) |
| Sender disclosure | tipper wallet | Opt into public disclosure metadata on a receipt | [contract addresses](/resources/contract-addresses/) |
| Private-tip unlock | tipper or linked recipient or agent owner | Read a private tip's note + amount without paying x402 | issued by `/tips/:tipId/auth-challenge` |
| Paid third-party reveal | x402 facilitator | Read a private tip's note + amount in exchange for the fixed USDC unlock price | [x402 protocol](/api-reference/x402-protocol/) |

## Recipient link voucher

How the link gets bound:

1. The recipient finishes OAuth on the hosted claim UI, proving they control a GitHub or X handle.
2. The Boon Worker reads live nonce and link state for the handle.
3. The Boon Worker signs an EIP-712 Link voucher binding `(handleHash, recipient wallet, nonce)` with its `trustedSigner` key.
4. If pending USDC exists, the escrow guardian signs the same digest.
5. The relayer submits `link(...)`, `linkEscrowed(...)`, or `linkAndClaim(...)` depending on the handle state.

Voucher fields:

```text
handleHash     bytes32   keccak256(canonical handle)
recipient      address   wallet that will receive pending and future tips
nonce          uint256   current nonce for the handle
signature      bytes     trusted-signer authorization
```

Already-linked handles are refused unless an operator-assisted `relink` flow is in use.

## Sender disclosure signature

Tippers can opt a public receipt into showing disclosure metadata by signing:

```text
Disclosure(bytes32 txHash, string action)
```

Endpoints:

```http
POST   /api/v1/boons/:txHash/disclosure
DELETE /api/v1/boons/:txHash/disclosure
```

The Worker checks the recovered signer against the indexed `tipper` for that receipt and refuses if the subgraph cannot verify it. The EIP-712 domain matches the Boon receipt source.

## Private-tip unlock signature

A private tip's note + amount are encrypted at rest. Three principals can read them for free: the original tipper, the linked wallet for a GitHub/X recipient, and the current ERC-8004 owner or agent wallet for an `agent:N` recipient. Everyone else pays the fixed x402 price.

The free-read flow uses a one-time signed challenge:

1. Client calls `POST /tips/:tipId/auth-challenge`. The Worker issues a short-lived single-use nonce.
2. Client signs an EIP-712 `PrivateTipUnlock(uint256 tipId, bytes32 nonce, uint256 deadline)` with the wallet they claim.
3. Client calls `GET /tips/:tipId` with the recovered address, signature, nonce, and deadline in headers (`x-boon-auth-address`, `x-boon-auth-sig`, `x-boon-auth-nonce`, `x-boon-auth-deadline`).

Worker order: verify signature → check authorization (signer is tipper / linked recipient / agent owner) → consume the nonce. If authorization fails, the nonce stays alive for the rightful caller.

If no auth headers are supplied, `GET /tips/:tipId` falls back to the third-party paid x402 reveal path.

## Paid third-party reveal

Strangers read a private tip's note + amount by paying the fixed `UNLOCK_PRICE_USDC` ($1) through x402. Payment routes 100% to the tipper via per-tip `DynamicPayTo`. See [x402 protocol](/api-reference/x402-protocol/) for the request shape and [x402 paid endpoints](/api-reference/x402-paid-endpoints/) for the full list of paid routes.
