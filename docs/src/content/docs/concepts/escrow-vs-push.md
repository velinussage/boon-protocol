---
title: Settlement model
description: How Boon handles walletless GitHub/X recipients, linked recipients, and ERC-8004 agents.
---

# Settlement model

Boon has two user-visible settlement paths: pending settlement for walletless social handles, and direct push for recipients whose payout wallet is known at send time.

## GitHub and X: send now, claim later

A sender can fund a Boon to `github:alice` or `x:bob` before that person has ever used Boon. The contract records a per-tip pending settlement entry:

- tipper wallet;
- USDC amount;
- canonical handle hash;
- optional private-tip commitment;
- optional recipient proof intent;
- creation time for the refund window.

The USDC sits in the Boon contract until the recipient proves the handle through OAuth and chooses a receiving wallet. Claiming links the handle and sweeps the pending entries to that first claim wallet.

```text
Sender wallet
    │ BoonV3.tip(...) or BoonV3.tipPrivate(...)
    ▼
┌────────────────────────────────────────────────────────┐
│  Boon on Base                                          │
│                                                        │
│  linkedWallet[handleHash] == 0x0 ?                     │
│    yes → create per-tip pending settlement entry      │
│          recipient claims after OAuth                  │
│    no  → transfer USDC to linked wallet immediately    │
└────────────────────────────────────────────────────────┘
```

## Linked GitHub/X handles: direct push

Once a handle is linked, new tips bypass pending settlement. The send transaction transfers USDC directly to the current linked wallet and emits the public or private tip event.

Relinking changes the destination for future direct tips. It does not move already-claimed funds, and it does not redirect entries that were already waiting for the first claim wallet.

## ERC-8004 agents: direct resolution

`agent:N` recipients do not use OAuth. Boon resolves the ERC-8004 IdentityRegistry on Base and sends to the registered agent wallet, falling back to the agent NFT owner when appropriate. The sender signs against an expected payout wallet so a stale or surprising registry read can fail before funds move.

There is no walletless pending-claim path for `agent:N`: an agent identity must resolve onchain at send time.

## Refunds

A sender can recover USDC from an unclaimed pending settlement entry after the refund delay. `$BOON` burned for privacy or recipient-proof actions is not refunded.

Refunds are a sender escape hatch for abandoned tips. They are not an operator sweep, and they do not let Boon take recipient funds.

## Recipient claim cost

Boon does not charge recipients to view, link, or claim. If the hosted relayer is enabled, Boon pays the Base gas for the link/claim transaction. If the relayer cannot safely complete the claim, the UI and CLI fail closed with an explicit error.

See also [OAuth claim flow](/concepts/oauth-claim-flow/), [private tips](/concepts/private-tips/), and [attestations](/concepts/attestations/).
