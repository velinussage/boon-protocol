---
title: Private commitments for walletless recipients
description: How Boon records private-tip commitments for GitHub/X recipients who have not linked yet.
---

# Private commitments for walletless recipients

Boon lets a sender fund a private thank-you while the recipient is still walletless. The sender does not need to wait for the recipient to join.

## How it works

1. The sender writes the private note in the app or CLI.
2. The client uploads encrypted private-tip metadata to the hosted Boon API.
3. The sender signs the onchain `tipPrivate(...)` transaction.
4. Boon escrows the USDC per tip, burns the fixed `$BOON` privacy amount, and records a private commitment.
5. When the recipient proves the GitHub/X handle and claims, the USDC settles to the first claim wallet.
6. The recipient can read the private detail for free after signing the recipient auth challenge.

## What the recipient can see before reveal

The public and claim surfaces may show that a private Boon exists, along with safe aggregate context such as pending USDC totals. They do not expose private note text, plaintext blob contents, or decryptable material without recipient/tipper auth or third-party x402 payment.

## Why commitments are handle-bound

The private commitment is tied to the canonical handle hash and the tipper's signed upload. That keeps the private note aligned with the same identity that receives the claim. Wallet resolution happens later, at OAuth claim time.

## Expiration and refunds

The USDC follows the normal pending settlement refund window. If the recipient never claims, the original tipper can recover the USDC after the delay. `$BOON` burned for private/proof actions remains burned.

See [private tips](/concepts/private-tips/) and [settlement model](/concepts/escrow-vs-push/).
