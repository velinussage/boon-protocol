---
title: Concepts
description: How Boon settlement, claims, agents, and reads fit together.
---

# Concepts

Boon has nine core concepts:

- [Handles](/concepts/canonical-handles/): one normalized recipient string.
- [Settlement](/concepts/escrow-vs-push/): walletless GitHub and X tips wait for claim; linked handles and agents receive direct push.
- [OAuth claims](/concepts/oauth-claim-flow/): GitHub and X recipients prove ownership before claiming.
- [Agent-native recipients](/concepts/agent-recipients/): `agent:N` resolves through ERC-8004 and does not use OAuth.
- [Private tips](/concepts/private-tips/): fixed `$BOON` burn, hidden Boon note/display amount, and x402 reveal.
- [Private commits](/concepts/private-tip-intents/): how private tips wait for unlinked GitHub and X recipients.
- [Attestations](/concepts/attestations/): optional soulbound proof cards.
- [OWS wallet](/concepts/ows-agent-wallet/): agent sends use a small, policy-scoped wallet.
- [Subgraph](/concepts/data-layer/): how events become the board, points, profiles, and API reads.

If you only remember one thing: Boon is not a payroll system or an autonomous payout bot. It is the gratuity graph. Every Boon is a public review with money behind it: retroactive recognition with visible receipts, explicit approval, and small bounded USDC transfers on Base.

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

Use the contract boundary for settlement, claims, and canonical handle hashes. Use the hosted API boundary for OAuth, indexed board/profile/receipt data, relayed claims, A2A previews, or paid graph reads.
