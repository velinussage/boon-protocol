---
title: Claim a boon
description: Prove your GitHub or X handle, link a wallet, and claim pending Boons.
---

# Claim a boon

Use `/claim` to prove your GitHub or X handle and link the wallet that should receive pending and future boons.

## Steps

1. Open [boonprotocol.com/claim](https://boonprotocol.com/claim).
2. Sign in with the provider for the tipped handle.
3. Review the proven handle and pending amount.
4. Connect the wallet that should receive this and future boons.
5. Confirm that the first claim wallet is correct.
6. Let the relayer submit link + claim when it is enabled.

## Wallet choices

- **Coinbase**: passkey/no-seed path for new wallet users.
- **Metamask/injected**: use an existing browser wallet.
- **WalletConnect**: use mobile wallets, Safe, Ledger Live, and other compatible wallets.

## What the link means

After your handle is linked:

- Pending entries for that handle settle to the first claim wallet.
- Future tips push directly to the current linked wallet.
- Operator-assisted relink can change the wallet for future direct tips, but it cannot move funds already delivered and cannot redirect pending entries away from the first claim wallet.
- Already-pushed funds cannot be moved by Boon.

## Manual fallback

If the hosted relayer is not enabled, the public UI should fail closed. Do not trust a flow that claims success without a transaction or receipt.

For help, send the receipt or handle to the sender, or open an issue in [github.com/velinussage/boon-protocol](https://github.com/velinussage/boon-protocol/issues).

If a hosted claim flow claims success without showing a transaction hash or receipt, stop and ask the sender or operator rather than retrying.
