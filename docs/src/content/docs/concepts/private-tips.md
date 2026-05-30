---
title: Private tips
description: How Boon hides note and display amount from the public Boon read path while keeping USDC settlement on Base.
---

# Private tips

Private tips are funded USDC thank-yous with a narrower public read surface. The tip still settles on Base, but the Boon event and public subgraph do not publish the note or display amount.

Private tips are for moments where the sender wants to fund gratitude without making the message and display amount part of the public Boon board.

## What changes

A normal public tip writes the recipient, amount, and note into the public Boon read path. A private tip changes that shape:

1. The sender creates a private-tip blob with the hosted Boon API.
2. The sender sends the funded USDC tip onchain through `tipPrivate(...)` or `tipPrivateAgent(...)`.
3. The sender burns the fixed private-tip amount of `$BOON` atomically in the same transaction.
4. The contract emits a private commitment instead of the public note and amount.
5. The recipient and original tipper can read the private details for free after signing the auth challenge.
6. Any other viewer must pay the fixed x402 reveal price before the hosted API returns the private note and amount.

| Mechanic | Value |
| --- | ---: |
| Private-tip burn | `500,000 $BOON` |
| Third-party reveal price | `$1 USDC` |
| Recipient read | Free after auth |
| Tipper read | Free after auth |

The x402 reveal payment settles to the original tipper. It is not a Boon protocol treasury fee.

## Walletless private tips

A private tip can be sent to a GitHub/X handle before the recipient has linked a wallet. Boon records the USDC, private commitment, and optional attestation intent in a per-tip pending settlement entry. When the recipient proves the handle and claims, the USDC settles and the recipient can authenticate to read the private details.

## What stays public

Private tips are private at the Boon app/subgraph layer, not shielded settlement.

Public observers may still see:

- the sender wallet interacting with the Boon contract;
- USDC transfer traces;
- `$BOON` burn traces;
- transaction timing and gas metadata;
- a private commitment proving a private tip exists.

Do not use private tips when you need settlement-amount privacy from chain analysts. Use them when you want Boon receipts, board rows, and public API responses to avoid showing the private note and display amount.

## Unlocking a private receipt

Private detail lives on the receipt page for the original transaction. Boon does not have a separate unlock page.

- Recipient or tipper: open the receipt and sign the challenge to read for free.
- Everyone else: pay the fixed x402 reveal price and receive the same private detail.

The public receipt still shows that the tip is private. The private note and amount appear only after a successful recipient/tipper auth read or x402 unlock.

## What private tips are not

Private tips do not create:

- holder tiers;
- balance-threshold access;
- staking, yield, revenue share, or governance;
- per-tip reveal pricing;
- zero-price public reveal paths.

The only token mechanic is the fixed burn to make the funded tip private. The only reveal mechanic is the fixed x402 price for third-party reads.
