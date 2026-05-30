---
title: OAuth claim flow
description: How Boon recipients prove account ownership, link a wallet, and claim pending tips.
---

# OAuth claim flow

The recipient front door is identity-first. A recipient proves the social account before choosing the wallet that will receive pending and future boons.

## What happens, end to end

1. Recipient opens `/claim` and starts GitHub or X OAuth through the Boon Worker.
2. The provider redirects back to the Worker callback. The Worker normalizes the proven handle to a canonical form such as `github:alice` or `x:bob`.
3. The Worker reads live link state from the Boon contract.
4. The recipient picks the wallet that should receive pending entries and future direct tips.
5. The Worker signs an EIP-712 Link voucher with its `trustedSigner` key. When pending USDC exists, the escrow guardian co-signs the first-link settlement path.
6. The hosted relayer submits the link + claim transaction when enabled. If not enabled, the UI fails closed instead of asking the recipient to guess at gas.
7. Pending entries settle to the first claim wallet. Future direct tips use the current linked wallet.

## First claim wallet vs linked wallet

Boon tracks two related wallet bindings:

- `linkedWallet[handleHash]` is the current destination for new direct tips.
- `firstClaimWallet[handleHash]` is set on the first successful link and receives entries that were already pending for that handle.

This protects recipients during recovery. If a handle later relinks to a new wallet, future tips can go to the new wallet, but already-pending entries remain bound to the original first claim wallet.

## CLI device-code flow

Cloud agents often run on a remote machine while the operator's browser and social login live on a phone or laptop. The CLI uses a device-code shape instead of a localhost callback:

```text
Agent CLI ──▶ POST /auth/cli/device/start
              │ prints BOON-....-.... and https://boonprotocol.com/cli
              ▼
Operator opens /cli on another device
              │ enters code, sees expected handle + receiving wallet
              ▼
Worker starts GitHub/X OAuth with a device-bound state
              │ callback proves the exact canonical handle the CLI requested
              ▼
/cli/done shows aggregate pending USDC + a permanence checkbox
              │ operator approves or denies
              ▼
CLI poll receives a short-lived claim session token exactly once
              │
              ▼
POST /claim/complete links the handle and claims pending entries through the relayer
```

The browser never receives the device code or claim session token. The CLI binds the receiving wallet and expected canonical handle before OAuth starts, so a stolen user code cannot redirect funds to another wallet or complete as a different social account.

## Voucher fields

```text
handleHash      keccak256(canonical handle)
recipient       receiving wallet
nonce           contract nonce for the handle
signature       trusted-signer authorization
```

The signature is domain-bound to Boon on Base and to the exact contract that accepts it. When pending USDC exists, the guardian signs the same handle, recipient, and nonce.

## Recovery and recipient cost

Boon includes `relink()` for operator-assisted recovery. Relinking changes where future direct tips go; it cannot move funds already delivered and cannot redirect pending entries away from the first claim wallet.

Boon does not charge recipients to view, link, or claim. If the hosted relayer is enabled, Boon pays Base gas. If it is not, the UI fails closed instead of leaving recipients to handle manual gas steps.

See also [settlement model](/concepts/escrow-vs-push/) for what happens to a tip when a handle has not linked yet.
