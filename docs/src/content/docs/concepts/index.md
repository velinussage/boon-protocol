---
title: Concepts
description: The core product and protocol ideas behind Boon.
---

# Concepts

Boon has ten load-bearing concepts:

- [Canonical handles](/concepts/canonical-handles/): one normalized social identity string per recipient.
- [Settlement model](/concepts/escrow-vs-push/): walletless GitHub/X tips wait as per-tip pending settlement entries; linked handles and agents receive direct push.
- [BoonV3](/concepts/boon-v3/): the v3 contract generation for walletless private tips, deferred attestations, first-claim-wallet protection, and the Hardhat-fork-to-mainnet launch path.
- [OAuth claim flow](/concepts/oauth-claim-flow/): recipients prove GitHub or X ownership before linking and claiming.
- [Agent recipients](/concepts/agent-recipients/): how `agent:N` resolves ERC-8004 recipients.
- [Private tips](/concepts/private-tips/): fixed `$BOON` burn, hidden Boon note/display amount, and x402 reveal.
- [Private commitments for walletless recipients](/concepts/private-tip-intents/): how private tips are prepared and settled for GitHub/X recipients who have not linked yet.
- [Gratitude attestations](/concepts/attestations/): optional soulbound proof cards for recipients.
- [OWS agent wallet](/concepts/ows-agent-wallet/): agents spend only from a small, policy-scoped wallet.
- [Data layer (subgraph)](/concepts/data-layer/): how onchain events become the board, points, profile, and graph reads.

If you only remember one thing: Boon is not a payroll system or autonomous payout bot. It is retroactive gratitude with visible receipts, explicit approval, and small bounded USDC transfers on Base.

## Onchain protocol vs hosted API

```text
contract + handle normalization + EIP-712 vouchers
        │
        ├─ works with Base RPC + wallet/OWS; no x402 required
        │
        ▼
hosted API + indexer + OAuth/relayer + x402 graph reads
        │
        └─ powers the public app, claim UX, aggregate reads, and paid agent graph data
```

Use the contract boundary when you are reasoning about settlement, claims, and canonical handle hashes. Use the hosted API boundary when you need OAuth, indexed board/profile/receipt data, relayed claims, or paid graph reads.
